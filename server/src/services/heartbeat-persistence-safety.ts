import { types as utilTypes } from "node:util";
import type { AdapterExecutionResult } from "../adapters/types.js";

const OMIT = Symbol("heartbeat-persistence-omit");
const TRUNCATED = "[paperclip truncated unsafe heartbeat value]";

const MAX_DEPTH = 20;
const MAX_NODES = 10_000;
const MAX_LEAVES = 10_000;
const MAX_WORK_UNITS = 25_000;
const MAX_OUTPUT_SLOTS = 10_000;
const MAX_OUTPUT_BYTES = 4_000_000;
const MAX_ARRAY_ITEMS = 2_000;
const MAX_OBJECT_KEYS = 2_000;
const MAX_STRING_CHARS = 1_000_000;
const MAX_TOTAL_STRING_CHARS = 4_000_000;
const MAX_KEY_CHARS = 1_024;

export const HEARTBEAT_PERSISTENCE_LIMITS = Object.freeze({
  maxDepth: MAX_DEPTH,
  maxNodes: MAX_NODES,
  maxLeaves: MAX_LEAVES,
  maxWorkUnits: MAX_WORK_UNITS,
  maxOutputSlots: MAX_OUTPUT_SLOTS,
  maxOutputBytes: MAX_OUTPUT_BYTES,
  maxArrayItems: MAX_ARRAY_ITEMS,
  maxObjectKeys: MAX_OBJECT_KEYS,
});

export const ADAPTER_EXECUTION_RESULT_FIELDS = [
  "exitCode",
  "signal",
  "timedOut",
  "errorMessage",
  "errorCode",
  "errorFamily",
  "retryNotBefore",
  "errorMeta",
  "usage",
  "sessionId",
  "sessionParams",
  "sessionDisplayId",
  "provider",
  "biller",
  "model",
  "billingType",
  "costUsd",
  "resultJson",
  "runtimeServices",
  "summary",
  "clearSession",
  "question",
] as const;

type AdapterExecutionResultField = (typeof ADAPTER_EXECUTION_RESULT_FIELDS)[number];

type SanitizerState = {
  nodes: number;
  leaves: number;
  workUnits: number;
  outputSlots: number;
  outputBytes: number;
  stringChars: number;
  ancestors: WeakSet<object>;
  seen: WeakSet<object>;
};

export class InvalidAdapterExecutionResultError extends Error {
  readonly code = "invalid_adapter_execution_result";

  constructor(reason: string) {
    super(`Adapter returned an invalid execution result: ${reason}`);
    this.name = "InvalidAdapterExecutionResultError";
  }
}

export function sanitizeHeartbeatPersistenceText(value: string): string {
  return value.replace(/\u0000/g, "\uFFFD");
}

function consumeWork(state: SanitizerState, units = 1): boolean {
  if (state.workUnits + units > MAX_WORK_UNITS) return false;
  state.workUnits += units;
  return true;
}

function consumeLeaf(state: SanitizerState, bytes: number): boolean {
  if (state.leaves >= MAX_LEAVES || state.outputBytes + bytes > MAX_OUTPUT_BYTES) return false;
  state.leaves += 1;
  state.outputBytes += bytes;
  return true;
}

function reservePropertySlot(state: SanitizerState, key: string): boolean {
  const keyBytes = Buffer.byteLength(key, "utf8");
  if (
    state.outputSlots >= MAX_OUTPUT_SLOTS ||
    state.outputBytes + keyBytes > MAX_OUTPUT_BYTES
  ) return false;
  state.outputSlots += 1;
  state.outputBytes += keyBytes;
  return true;
}

function maxPrefixForUtf8Bytes(value: string, maxBytes: number): number {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return low;
}

function truncateString(value: string, state: SanitizerState): string | typeof OMIT {
  if (state.leaves >= MAX_LEAVES) return OMIT;
  const sanitized = sanitizeHeartbeatPersistenceText(value);
  const remainingChars = Math.max(0, MAX_TOTAL_STRING_CHARS - state.stringChars);
  const remainingBytes = Math.max(0, MAX_OUTPUT_BYTES - state.outputBytes);
  let allowed = Math.min(MAX_STRING_CHARS, remainingChars, sanitized.length);
  if (Buffer.byteLength(sanitized.slice(0, allowed), "utf8") > remainingBytes) {
    allowed = maxPrefixForUtf8Bytes(sanitized.slice(0, allowed), remainingBytes);
  }
  if (!consumeLeaf(state, Buffer.byteLength(sanitized.slice(0, allowed), "utf8"))) return OMIT;
  state.stringChars += allowed;
  if (sanitized.length <= allowed) return sanitized;
  if (allowed <= TRUNCATED.length) return TRUNCATED.slice(0, allowed);
  return `${sanitized.slice(0, allowed - TRUNCATED.length)}${TRUNCATED}`;
}

function nextCollisionFreeKey(
  target: Record<string, unknown>,
  base: string,
  collisionCounts: Map<string, number>,
  state: SanitizerState,
): string | null {
  if (!Object.prototype.hasOwnProperty.call(target, base)) return base;
  let suffix = collisionCounts.get(base) ?? 2;
  let candidate = `${base} [collision ${suffix}]`;
  while (Object.prototype.hasOwnProperty.call(target, candidate)) {
    if (!consumeWork(state)) return null;
    suffix += 1;
    candidate = `${base} [collision ${suffix}]`;
  }
  collisionCounts.set(base, suffix + 1);
  return candidate;
}

function isPlainRecord(value: object): boolean {
  if (utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeBoxedPrimitive(value: object): unknown | typeof OMIT {
  if (!utilTypes.isBoxedPrimitive(value)) return OMIT;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === String.prototype) return String.prototype.valueOf.call(value);
  if (prototype === Number.prototype) return Number.prototype.valueOf.call(value);
  if (prototype === Boolean.prototype) return Boolean.prototype.valueOf.call(value);
  if (prototype === BigInt.prototype) return BigInt.prototype.valueOf.call(value).toString();
  if (prototype === Symbol.prototype) return Symbol.prototype.valueOf.call(value).description ?? "";
  return OMIT;
}

function sanitizeValue(
  value: unknown,
  state: SanitizerState,
  depth: number,
): unknown | typeof OMIT {
  if (!consumeWork(state)) return OMIT;
  if (typeof value === "string") return truncateString(value, state);
  if (value === null) return consumeLeaf(state, 4) ? value : OMIT;
  if (typeof value === "boolean") return consumeLeaf(state, value ? 4 : 5) ? value : OMIT;
  if (typeof value === "number") {
    const normalized = Number.isFinite(value) ? value : null;
    return consumeLeaf(state, normalized === null ? 4 : 24) ? normalized : OMIT;
  }
  if (typeof value === "bigint") return truncateString(value.toString(), state);
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return OMIT;
  if (depth >= MAX_DEPTH || state.nodes >= MAX_NODES) return truncateString(TRUNCATED, state);
  if (utilTypes.isProxy(value)) return consumeLeaf(state, 4) ? null : OMIT;

  if (state.ancestors.has(value)) return truncateString("[Circular]", state);
  if (state.seen.has(value)) return truncateString("[Shared reference]", state);
  state.seen.add(value);

  state.nodes += 1;

  if (utilTypes.isDate(value)) {
    const time = Date.prototype.getTime.call(value);
    return Number.isFinite(time)
      ? truncateString(new Date(time).toISOString(), state)
      : consumeLeaf(state, 4) ? null : OMIT;
  }

  const boxed = sanitizeBoxedPrimitive(value);
  if (boxed !== OMIT) return sanitizeValue(boxed, state, depth + 1);

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      const rawLength = typeof lengthDescriptor?.value === "number" ? lengthDescriptor.value : 0;
      const desiredLength = Math.min(Math.max(0, rawLength), MAX_ARRAY_ITEMS);
      const length = Math.min(
        desiredLength,
        Math.max(0, MAX_OUTPUT_SLOTS - state.outputSlots),
        Math.max(0, MAX_WORK_UNITS - state.workUnits),
      );
      state.outputSlots += length;
      state.workUnits += length;
      const output = new Array<unknown>(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) {
          output[index] = null;
          continue;
        }
        const sanitized = sanitizeValue(descriptor.value, state, depth + 1);
        output[index] = sanitized === OMIT ? null : sanitized;
      }
      if (rawLength > length && state.outputSlots < MAX_OUTPUT_SLOTS) {
        const marker = truncateString(TRUNCATED, state);
        if (marker !== OMIT) {
          state.outputSlots += 1;
          output.push(marker);
        }
      }
      return output;
    }

    if (!isPlainRecord(value)) return consumeLeaf(state, 4) ? null : OMIT;
    const output: Record<string, unknown> = {};
    const collisionCounts = new Map<string, number>();
    let storedKeys = 0;
    for (const key of Reflect.ownKeys(value)) {
      if (
        storedKeys >= MAX_OBJECT_KEYS ||
        state.outputSlots >= MAX_OUTPUT_SLOTS ||
        !consumeWork(state)
      ) break;
      if (typeof key !== "string") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) continue;
      const baseKey = sanitizeHeartbeatPersistenceText(key).slice(0, MAX_KEY_CHARS);
      const safeKey = nextCollisionFreeKey(output, baseKey, collisionCounts, state);
      if (safeKey === null) break;
      if (!reservePropertySlot(state, safeKey)) break;
      const sanitized = sanitizeValue(descriptor.value, state, depth + 1);
      if (sanitized === OMIT) continue;
      Object.defineProperty(output, safeKey, {
        value: sanitized,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      storedKeys += 1;
    }
    return output;
  } finally {
    state.ancestors.delete(value);
  }
}

function createState(): SanitizerState {
  return {
    nodes: 0,
    leaves: 0,
    workUnits: 0,
    outputSlots: 0,
    outputBytes: 0,
    stringChars: 0,
    ancestors: new WeakSet<object>(),
    seen: new WeakSet<object>(),
  };
}

export function sanitizeHeartbeatPersistenceValue(value: unknown): unknown {
  const sanitized = sanitizeValue(value, createState(), 0);
  return sanitized === OMIT ? null : sanitized;
}

export function sanitizeHeartbeatPersistenceRecord(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeHeartbeatPersistenceValue(value);
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) return {};
  return sanitized as Record<string, unknown>;
}

function ownDataField(
  value: object,
  field: AdapterExecutionResultField,
): { present: boolean; value?: unknown; accessor?: boolean } {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (!descriptor) return { present: false };
  if (!("value" in descriptor)) return { present: true, accessor: true };
  return { present: true, value: descriptor.value };
}

type KnownFieldCandidate = ReturnType<typeof ownDataField>;

function isRawPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    !utilTypes.isProxy(value) && isPlainRecord(value);
}

function validateOptionalField(field: AdapterExecutionResultField, value: unknown): boolean {
  const nullableStringFields: readonly AdapterExecutionResultField[] = [
    "errorMessage",
    "errorCode",
    "retryNotBefore",
    "sessionId",
    "sessionDisplayId",
    "provider",
    "biller",
    "model",
    "summary",
  ];
  if (nullableStringFields.includes(field)) return value === null || typeof value === "string";
  if (field === "errorFamily") {
    return value === null || value === "transient_upstream" || value === "model_refusal";
  }
  if (field === "billingType") {
    return value === null || (typeof value === "string" && [
      "api",
      "subscription",
      "metered_api",
      "subscription_included",
      "subscription_overage",
      "credits",
      "fixed",
      "unknown",
    ].includes(value));
  }
  if (field === "costUsd") return value === null || (typeof value === "number" && Number.isFinite(value));
  if (field === "clearSession") return typeof value === "boolean";
  if (field === "runtimeServices") return Array.isArray(value) && !utilTypes.isProxy(value);
  if (field === "sessionParams" || field === "resultJson" || field === "question") {
    return value === null || isRawPlainRecord(value);
  }
  if (field === "errorMeta" || field === "usage") return isRawPlainRecord(value);
  return false;
}

export function normalizeAdapterExecutionResultForPersistence(input: unknown): AdapterExecutionResult {
  if (!input || typeof input !== "object" || utilTypes.isProxy(input) || !isPlainRecord(input)) {
    throw new InvalidAdapterExecutionResultError("root value must be a plain, non-proxy object");
  }

  const candidates = new Map<AdapterExecutionResultField, KnownFieldCandidate>();
  for (const field of ADAPTER_EXECUTION_RESULT_FIELDS) {
    const candidate = ownDataField(input, field);
    if (candidate.present && candidate.accessor) {
      throw new InvalidAdapterExecutionResultError(`${field} must be a data property`);
    }
    candidates.set(field, candidate);
  }

  for (const field of ["exitCode", "signal", "timedOut"] as const) {
    if (!candidates.get(field)?.present) {
      throw new InvalidAdapterExecutionResultError(`missing required field ${field}`);
    }
  }

  const rawExitCode = candidates.get("exitCode")?.value;
  const rawSignal = candidates.get("signal")?.value;
  const rawTimedOut = candidates.get("timedOut")?.value;
  if (rawExitCode !== null && (typeof rawExitCode !== "number" || !Number.isInteger(rawExitCode))) {
    throw new InvalidAdapterExecutionResultError("exitCode must be an integer or null");
  }
  if (rawSignal !== null && typeof rawSignal !== "string") {
    throw new InvalidAdapterExecutionResultError("signal must be a string or null");
  }
  if (typeof rawTimedOut !== "boolean") {
    throw new InvalidAdapterExecutionResultError("timedOut must be a boolean");
  }

  for (const field of ADAPTER_EXECUTION_RESULT_FIELDS.slice(3)) {
    const candidate = candidates.get(field);
    if (candidate?.present && !validateOptionalField(field, candidate.value)) {
      throw new InvalidAdapterExecutionResultError(`${field} has an invalid value`);
    }
  }

  const state = createState();
  reservePropertySlot(state, "exitCode");
  const exitCode = sanitizeValue(rawExitCode, state, 0);
  reservePropertySlot(state, "signal");
  const signal = sanitizeValue(rawSignal, state, 0);
  reservePropertySlot(state, "timedOut");
  const timedOut = sanitizeValue(rawTimedOut, state, 0);
  const output: Record<string, unknown> = {
    exitCode: exitCode === OMIT ? null : exitCode,
    signal: signal === OMIT ? null : signal,
    timedOut: timedOut === OMIT ? false : timedOut,
  };
  for (const field of ADAPTER_EXECUTION_RESULT_FIELDS.slice(3)) {
    const candidate = candidates.get(field);
    if (!candidate?.present) continue;
    if (!reservePropertySlot(state, field)) break;
    const sanitized = sanitizeValue(candidate.value, state, 0);
    if (sanitized !== OMIT && validateOptionalField(field, sanitized)) output[field] = sanitized;
  }

  return output as unknown as AdapterExecutionResult;
}
