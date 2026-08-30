import { types as utilTypes } from "node:util";
import type { AdapterExecutionResult } from "../adapters/types.js";

const OMIT = Symbol("heartbeat-persistence-omit");
const TRUNCATED = "[paperclip truncated unsafe heartbeat value]";

const MAX_DEPTH = 20;
const MAX_NODES = 10_000;
const MAX_ARRAY_ITEMS = 2_000;
const MAX_OBJECT_KEYS = 2_000;
const MAX_STRING_CHARS = 1_000_000;
const MAX_TOTAL_STRING_CHARS = 4_000_000;
const MAX_KEY_CHARS = 1_024;

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
  stringChars: number;
  ancestors: WeakSet<object>;
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

function truncateString(value: string, state: SanitizerState): string {
  const sanitized = sanitizeHeartbeatPersistenceText(value);
  const remaining = Math.max(0, MAX_TOTAL_STRING_CHARS - state.stringChars);
  const allowed = Math.min(MAX_STRING_CHARS, remaining);
  if (sanitized.length <= allowed) {
    state.stringChars += sanitized.length;
    return sanitized;
  }
  state.stringChars += allowed;
  if (allowed <= TRUNCATED.length) return TRUNCATED.slice(0, allowed);
  return `${sanitized.slice(0, allowed - TRUNCATED.length)}${TRUNCATED}`;
}

function nextCollisionFreeKey(target: Record<string, unknown>, rawKey: string): string {
  const base = sanitizeHeartbeatPersistenceText(rawKey).slice(0, MAX_KEY_CHARS);
  if (!Object.prototype.hasOwnProperty.call(target, base)) return base;
  let suffix = 2;
  while (Object.prototype.hasOwnProperty.call(target, `${base} [collision ${suffix}]`)) suffix += 1;
  return `${base} [collision ${suffix}]`;
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
  if (typeof value === "string") return truncateString(value, state);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return OMIT;
  if (depth >= MAX_DEPTH || state.nodes >= MAX_NODES) return TRUNCATED;
  if (utilTypes.isProxy(value)) return null;

  state.nodes += 1;

  if (utilTypes.isDate(value)) {
    const time = Date.prototype.getTime.call(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
  }

  const boxed = sanitizeBoxedPrimitive(value);
  if (boxed !== OMIT) return sanitizeValue(boxed, state, depth + 1);

  if (state.ancestors.has(value)) return "[Circular]";
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      const rawLength = typeof lengthDescriptor?.value === "number" ? lengthDescriptor.value : 0;
      const length = Math.min(Math.max(0, rawLength), MAX_ARRAY_ITEMS);
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
      if (rawLength > MAX_ARRAY_ITEMS) output.push(TRUNCATED);
      return output;
    }

    if (!isPlainRecord(value)) return null;
    const output: Record<string, unknown> = {};
    let storedKeys = 0;
    for (const key of Reflect.ownKeys(value)) {
      if (storedKeys >= MAX_OBJECT_KEYS) break;
      if (typeof key !== "string") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) continue;
      const sanitized = sanitizeValue(descriptor.value, state, depth + 1);
      if (sanitized === OMIT) continue;
      const safeKey = nextCollisionFreeKey(output, key);
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
  return { nodes: 0, stringChars: 0, ancestors: new WeakSet<object>() };
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

function requiredField(
  input: object,
  field: "exitCode" | "signal" | "timedOut",
): unknown {
  const candidate = ownDataField(input, field);
  if (!candidate.present) throw new InvalidAdapterExecutionResultError(`missing required field ${field}`);
  if (candidate.accessor) throw new InvalidAdapterExecutionResultError(`required field ${field} must be a data property`);
  return sanitizeHeartbeatPersistenceValue(candidate.value);
}

function optionalField(input: object, field: AdapterExecutionResultField): unknown | typeof OMIT {
  const candidate = ownDataField(input, field);
  if (!candidate.present || candidate.accessor) return OMIT;
  return sanitizeHeartbeatPersistenceValue(candidate.value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function setOptional(
  output: Record<string, unknown>,
  input: object,
  field: AdapterExecutionResultField,
  accepts: (value: unknown) => boolean,
): void {
  const value = optionalField(input, field);
  if (value !== OMIT && accepts(value)) output[field] = value;
}

export function normalizeAdapterExecutionResultForPersistence(input: unknown): AdapterExecutionResult {
  if (!input || typeof input !== "object" || utilTypes.isProxy(input) || !isPlainRecord(input)) {
    throw new InvalidAdapterExecutionResultError("root value must be a plain, non-proxy object");
  }

  const exitCode = requiredField(input, "exitCode");
  const signal = requiredField(input, "signal");
  const timedOut = requiredField(input, "timedOut");

  if (exitCode !== null && (typeof exitCode !== "number" || !Number.isInteger(exitCode))) {
    throw new InvalidAdapterExecutionResultError("exitCode must be an integer or null");
  }
  if (signal !== null && typeof signal !== "string") {
    throw new InvalidAdapterExecutionResultError("signal must be a string or null");
  }
  if (typeof timedOut !== "boolean") {
    throw new InvalidAdapterExecutionResultError("timedOut must be a boolean");
  }

  const output: Record<string, unknown> = { exitCode, signal, timedOut };
  const nullableString = (value: unknown) => value === null || typeof value === "string";
  for (const field of [
    "errorMessage",
    "errorCode",
    "retryNotBefore",
    "sessionId",
    "sessionDisplayId",
    "provider",
    "biller",
    "model",
    "summary",
  ] as const) {
    setOptional(output, input, field, nullableString);
  }
  setOptional(output, input, "errorFamily", (value) =>
    value === null || value === "transient_upstream" || value === "model_refusal");
  setOptional(output, input, "billingType", (value) =>
    value === null || (typeof value === "string" && [
      "api",
      "subscription",
      "metered_api",
      "subscription_included",
      "subscription_overage",
      "credits",
      "fixed",
      "unknown",
    ].includes(value)));
  setOptional(output, input, "costUsd", (value) => value === null || typeof value === "number");
  setOptional(output, input, "clearSession", (value) => typeof value === "boolean");
  setOptional(output, input, "errorMeta", isRecord);
  setOptional(output, input, "usage", isRecord);
  setOptional(output, input, "sessionParams", (value) => value === null || isRecord(value));
  setOptional(output, input, "resultJson", (value) => value === null || isRecord(value));
  setOptional(output, input, "runtimeServices", Array.isArray);
  setOptional(output, input, "question", (value) => value === null || isRecord(value));

  return output as unknown as AdapterExecutionResult;
}
