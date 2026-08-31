import { types as utilTypes } from "node:util";
import type { AdapterExecutionResult } from "../adapters/types.js";
import { REDACTED_EVENT_VALUE, redactSensitiveText } from "../redaction.js";

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
const POSTGRES_INT32_MIN = -2_147_483_648;
const POSTGRES_INT32_MAX = 2_147_483_647;
const WINDOWS_UINT32_MAX = 4_294_967_295;
const UINT32_MODULUS = 4_294_967_296;

const SECRET_PAYLOAD_KEY_RE =
  /[A-Za-z0-9_-]*(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)[A-Za-z0-9_-]*/i;
const COMMAND_ARGS_PAYLOAD_KEY_RE = /^(commandArgs|command_?args|argv)$/i;
const CLI_SECRET_FLAG_RE =
  /^-{1,2}[A-Za-z0-9_-]*(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)[A-Za-z0-9_-]*$/i;
const DANGLING_JSON_SECRET_RE =
  /((?:\\?"|')?[A-Za-z0-9_-]*(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)[A-Za-z0-9_-]*(?:\\?"|')?\s*:\s*(?:\\?"|'))[^\r\n]*$/i;
const SECRET_TEXT_HINT_RE =
  /api|key|token|auth|bearer|secret|pass|credential|jwt|private|cookie|connectionstring/i;
const NON_SECRET_USAGE_KEYS = new Set([
  "inputtokens",
  "outputtokens",
  "cachedinputtokens",
  "rawinputtokens",
  "rawoutputtokens",
  "rawcachedinputtokens",
  "totaltokens",
  "tokencount",
  "maxtokens",
]);

export const HEARTBEAT_PERSISTENCE_LIMITS = Object.freeze({
  maxDepth: MAX_DEPTH,
  maxNodes: MAX_NODES,
  maxLeaves: MAX_LEAVES,
  maxWorkUnits: MAX_WORK_UNITS,
  maxOutputSlots: MAX_OUTPUT_SLOTS,
  maxOutputBytes: MAX_OUTPUT_BYTES,
  maxArrayItems: MAX_ARRAY_ITEMS,
  maxObjectKeys: MAX_OBJECT_KEYS,
  maxStringChars: MAX_STRING_CHARS,
  maxTotalStringChars: MAX_TOTAL_STRING_CHARS,
  maxKeyChars: MAX_KEY_CHARS,
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

export function normalizeHeartbeatExitCodeForPersistence(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value >= POSTGRES_INT32_MIN && value <= POSTGRES_INT32_MAX) return value;
  if (value > POSTGRES_INT32_MAX && value <= WINDOWS_UINT32_MAX) {
    return value - UINT32_MODULUS;
  }
  return null;
}

function prepareBoundedPersistenceText(value: string, maxChars: number) {
  const bounded = value.length > maxChars ? value.slice(0, maxChars) : value;
  let text = redactSensitiveText(bounded.replace(/\u0000/g, "\uFFFD"));
  const wasTruncated = value.length > maxChars || text.length > maxChars;
  if (wasTruncated && SECRET_TEXT_HINT_RE.test(text)) {
    // redactSensitiveText intentionally expects complete JSON strings. Cover a
    // bounded prefix that ends inside a quoted secret value as well.
    text = text.replace(DANGLING_JSON_SECRET_RE, `$1${REDACTED_EVENT_VALUE}`);
  }
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return { text, wasTruncated };
}

function appendTruncationMarker(value: string, maxChars: number) {
  if (maxChars <= 0) return "";
  if (maxChars <= TRUNCATED.length) return TRUNCATED.slice(0, maxChars);
  return `${value.slice(0, maxChars - TRUNCATED.length)}${TRUNCATED}`;
}

export function sanitizeHeartbeatPersistenceText(value: string): string {
  const prepared = prepareBoundedPersistenceText(value, MAX_STRING_CHARS);
  return prepared.wasTruncated
    ? appendTruncationMarker(prepared.text, MAX_STRING_CHARS)
    : prepared.text;
}

function consumeWork(state: SanitizerState, units = 1): boolean {
  if (state.workUnits + units > MAX_WORK_UNITS) return false;
  state.workUnits += units;
  return true;
}

function consumeOutputBytes(state: SanitizerState, bytes: number): boolean {
  if (bytes < 0 || state.outputBytes + bytes > MAX_OUTPUT_BYTES) return false;
  state.outputBytes += bytes;
  return true;
}

function consumeLeaf(state: SanitizerState, bytes: number): boolean {
  if (state.leaves >= MAX_LEAVES || !consumeOutputBytes(state, bytes)) return false;
  state.leaves += 1;
  return true;
}

function jsonCodePointByteLength(value: string, index: number): { bytes: number; codeUnits: number } {
  const code = value.charCodeAt(index);
  if (code === 0x22 || code === 0x5c) return { bytes: 2, codeUnits: 1 };
  if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
    return { bytes: 2, codeUnits: 1 };
  }
  if (code <= 0x1f) return { bytes: 6, codeUnits: 1 };
  if (code <= 0x7f) return { bytes: 1, codeUnits: 1 };
  if (code <= 0x7ff) return { bytes: 2, codeUnits: 1 };
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = value.charCodeAt(index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return { bytes: 4, codeUnits: 2 };
    return { bytes: 6, codeUnits: 1 };
  }
  if (code >= 0xdc00 && code <= 0xdfff) return { bytes: 6, codeUnits: 1 };
  return { bytes: 3, codeUnits: 1 };
}

function jsonStringContentByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length;) {
    const measured = jsonCodePointByteLength(value, index);
    bytes += measured.bytes;
    index += measured.codeUnits;
  }
  return bytes;
}

function jsonStringByteLength(value: string): number {
  return 2 + jsonStringContentByteLength(value);
}

function maxJsonStringPrefix(
  value: string,
  maxBytes: number,
  maxChars: number,
): { end: number; bytes: number } {
  let bytes = 0;
  let index = 0;
  const charLimit = Math.min(value.length, Math.max(0, maxChars));
  while (index < charLimit) {
    const measured = jsonCodePointByteLength(value, index);
    if (index + measured.codeUnits > charLimit || bytes + measured.bytes > maxBytes) break;
    bytes += measured.bytes;
    index += measured.codeUnits;
  }
  return { end: index, bytes };
}

function truncateString(value: string, state: SanitizerState): string | typeof OMIT {
  if (state.leaves >= MAX_LEAVES || MAX_OUTPUT_BYTES - state.outputBytes < 2) return OMIT;
  const remainingChars = Math.max(0, MAX_TOTAL_STRING_CHARS - state.stringChars);
  const maxChars = Math.min(MAX_STRING_CHARS, remainingChars);
  const prepared = prepareBoundedPersistenceText(value, maxChars);
  const availableContentBytes = MAX_OUTPUT_BYTES - state.outputBytes - 2;
  const fullPrefix = maxJsonStringPrefix(prepared.text, availableContentBytes, maxChars);
  const needsMarker = prepared.wasTruncated || fullPrefix.end < prepared.text.length;
  let result: string;
  let contentBytes: number;

  if (!needsMarker) {
    result = prepared.text;
    contentBytes = fullPrefix.bytes;
  } else {
    const markerBytes = jsonStringContentByteLength(TRUNCATED);
    if (maxChars >= TRUNCATED.length && availableContentBytes >= markerBytes) {
      const prefix = maxJsonStringPrefix(
        prepared.text,
        availableContentBytes - markerBytes,
        maxChars - TRUNCATED.length,
      );
      result = `${prepared.text.slice(0, prefix.end)}${TRUNCATED}`;
      contentBytes = prefix.bytes + markerBytes;
    } else {
      result = prepared.text.slice(0, fullPrefix.end);
      contentBytes = fullPrefix.bytes;
    }
  }

  if (!consumeLeaf(state, contentBytes + 2)) return OMIT;
  state.stringChars += result.length;
  return result;
}

function sanitizePersistenceKey(value: string) {
  const prepared = prepareBoundedPersistenceText(value, MAX_KEY_CHARS);
  return prepared.wasTruncated
    ? appendTruncationMarker(prepared.text, MAX_KEY_CHARS)
    : prepared.text;
}

function isSensitivePayloadKey(value: string) {
  const normalized = value.replace(/[-_]/g, "").toLowerCase();
  return !NON_SECRET_USAGE_KEYS.has(normalized) && SECRET_PAYLOAD_KEY_RE.test(value);
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
  options: { commandArgs?: boolean } = {},
): unknown | typeof OMIT {
  if (!consumeWork(state)) return OMIT;
  if (typeof value === "string") return truncateString(value, state);
  if (value === null) return consumeLeaf(state, 4) ? value : OMIT;
  if (typeof value === "boolean") return consumeLeaf(state, value ? 4 : 5) ? value : OMIT;
  if (typeof value === "number") {
    const normalized = Number.isFinite(value) ? value : null;
    const serialized = normalized === null ? "null" : JSON.stringify(normalized);
    return consumeLeaf(state, Buffer.byteLength(serialized, "utf8")) ? normalized : OMIT;
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
      if (!consumeOutputBytes(state, 2)) return OMIT;
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      const rawLength = typeof lengthDescriptor?.value === "number" ? lengthDescriptor.value : 0;
      const desiredLength = Math.min(Math.max(0, rawLength), MAX_ARRAY_ITEMS);
      const output: unknown[] = [];
      let redactNextCommandArg = false;
      for (let index = 0; index < desiredLength; index += 1) {
        if (
          state.outputSlots >= MAX_OUTPUT_SLOTS ||
          state.workUnits >= MAX_WORK_UNITS ||
          !consumeWork(state)
        ) break;
        const separatorBytes = output.length > 0 ? 1 : 0;
        if (!consumeOutputBytes(state, separatorBytes)) break;
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        let sanitized: unknown | typeof OMIT;
        if (options.commandArgs && redactNextCommandArg) {
          redactNextCommandArg = false;
          sanitized = sanitizeValue(REDACTED_EVENT_VALUE, state, depth + 1);
        } else if (!descriptor || !("value" in descriptor)) {
          sanitized = sanitizeValue(null, state, depth + 1);
        } else {
          const entry = descriptor.value;
          if (options.commandArgs && typeof entry === "string" && CLI_SECRET_FLAG_RE.test(entry.trim())) {
            redactNextCommandArg = true;
          }
          sanitized = sanitizeValue(entry, state, depth + 1);
        }
        if (sanitized === OMIT) {
          state.outputBytes -= separatorBytes;
          break;
        }
        state.outputSlots += 1;
        output.push(sanitized);
      }
      if (rawLength > output.length && state.outputSlots < MAX_OUTPUT_SLOTS) {
        const separatorBytes = output.length > 0 ? 1 : 0;
        if (consumeOutputBytes(state, separatorBytes)) {
          const marker = truncateString(TRUNCATED, state);
          if (marker !== OMIT) {
            state.outputSlots += 1;
            output.push(marker);
          } else {
            state.outputBytes -= separatorBytes;
          }
        }
      }
      return output;
    }

    if (!isPlainRecord(value)) return consumeLeaf(state, 4) ? null : OMIT;
    if (!consumeOutputBytes(state, 2)) return OMIT;
    const output: Record<string, unknown> = {};
    const collisionCounts = new Map<string, number>();
    let storedKeys = 0;
    // for..in is deliberately incremental. Reflect.ownKeys/Object.keys would
    // allocate an array proportional to attacker-controlled input before the
    // work budget had a chance to stop traversal.
    for (const key in value) {
      if (
        storedKeys >= MAX_OBJECT_KEYS ||
        state.outputSlots >= MAX_OUTPUT_SLOTS ||
        !consumeWork(state)
      ) break;
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) continue;
      const baseKey = sanitizePersistenceKey(key);
      const safeKey = nextCollisionFreeKey(output, baseKey, collisionCounts, state);
      if (safeKey === null) break;
      const propertyBytes = (storedKeys > 0 ? 1 : 0) + jsonStringByteLength(safeKey) + 1;
      if (!consumeOutputBytes(state, propertyBytes)) break;
      const rawEntry = isSensitivePayloadKey(key)
        ? REDACTED_EVENT_VALUE
        : descriptor.value;
      const sanitized = sanitizeValue(rawEntry, state, depth + 1, {
        commandArgs: COMMAND_ARGS_PAYLOAD_KEY_RE.test(key),
      });
      if (sanitized === OMIT) {
        state.outputBytes -= propertyBytes;
        continue;
      }
      state.outputSlots += 1;
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

function invalidContract(reason: string): never {
  throw new InvalidAdapterExecutionResultError(reason);
}

function readContractField(
  record: Record<string, unknown>,
  field: string,
  path: string,
  required = false,
) {
  const descriptor = Object.getOwnPropertyDescriptor(record, field);
  if (!descriptor) {
    if (required) invalidContract(`${path}.${field} is required`);
    return { present: false as const, value: undefined };
  }
  if (!("value" in descriptor)) invalidContract(`${path}.${field} must be a data property`);
  return { present: true as const, value: descriptor.value };
}

function readContractArrayLength(value: unknown, path: string): { array: unknown[]; length: number } {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) {
    invalidContract(`${path} must be a non-proxy array`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = descriptor && "value" in descriptor && typeof descriptor.value === "number"
    ? descriptor.value
    : -1;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ARRAY_ITEMS) {
    invalidContract(`${path} exceeds the maximum of ${MAX_ARRAY_ITEMS} items`);
  }
  return { array: value, length };
}

function requirePlainContractRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRawPlainRecord(value)) invalidContract(`${path} must be a plain, non-proxy object`);
  return value;
}

function requireString(value: unknown, path: string, options: { nonEmpty?: boolean } = {}) {
  if (typeof value !== "string" || (options.nonEmpty && value.trim().length === 0)) {
    invalidContract(`${path} must be ${options.nonEmpty ? "a non-empty string" : "a string"}`);
  }
  return value;
}

function optionalNullableString(record: Record<string, unknown>, field: string, path: string) {
  const candidate = readContractField(record, field, path);
  if (!candidate.present) return candidate;
  if (candidate.value !== null && typeof candidate.value !== "string") {
    invalidContract(`${path}.${field} must be a string or null`);
  }
  return candidate;
}

function canonicalizeUsage(value: unknown) {
  const record = requirePlainContractRecord(value, "usage");
  const inputTokens = readContractField(record, "inputTokens", "usage", true).value;
  const outputTokens = readContractField(record, "outputTokens", "usage", true).value;
  const cachedInputTokens = readContractField(record, "cachedInputTokens", "usage");
  for (const [path, tokenCount] of [
    ["usage.inputTokens", inputTokens],
    ["usage.outputTokens", outputTokens],
    ...(cachedInputTokens.present ? [["usage.cachedInputTokens", cachedInputTokens.value]] : []),
  ] as Array<[string, unknown]>) {
    if (typeof tokenCount !== "number" || !Number.isFinite(tokenCount) || tokenCount < 0) {
      invalidContract(`${path} must be a finite non-negative number`);
    }
  }
  return {
    inputTokens: inputTokens as number,
    outputTokens: outputTokens as number,
    ...(cachedInputTokens.present ? { cachedInputTokens: cachedInputTokens.value as number } : {}),
  };
}

const RUNTIME_STRING_FIELDS = [
  "id",
  "projectId",
  "projectWorkspaceId",
  "issueId",
  "scopeId",
  "reuseKey",
  "command",
  "cwd",
  "url",
  "providerRef",
  "ownerAgentId",
] as const;

function canonicalizeRuntimeServices(value: unknown) {
  const { array, length } = readContractArrayLength(value, "runtimeServices");
  const reports: Record<string, unknown>[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
    if (!descriptor || !("value" in descriptor)) {
      invalidContract(`runtimeServices[${index}] must be an own data property`);
    }
    const path = `runtimeServices[${index}]`;
    const report = requirePlainContractRecord(descriptor.value, path);
    const serviceName = readContractField(report, "serviceName", path, true).value;
    const normalized: Record<string, unknown> = {
      serviceName: requireString(serviceName, `${path}.serviceName`, { nonEmpty: true }),
    };
    for (const field of RUNTIME_STRING_FIELDS) {
      const candidate = optionalNullableString(report, field, path);
      if (candidate.present) normalized[field] = candidate.value;
    }
    for (const [field, allowed] of [
      ["scopeType", ["project_workspace", "execution_workspace", "run", "agent"]],
      ["status", ["starting", "running", "stopped", "failed"]],
      ["lifecycle", ["shared", "ephemeral"]],
      ["healthStatus", ["unknown", "healthy", "unhealthy"]],
    ] as const) {
      const candidate = readContractField(report, field, path);
      if (!candidate.present) continue;
      if (typeof candidate.value !== "string" || !allowed.includes(candidate.value as never)) {
        invalidContract(`${path}.${field} has an invalid enum value`);
      }
      normalized[field] = candidate.value;
    }
    const port = readContractField(report, "port", path);
    if (port.present) {
      if (port.value !== null && (
        typeof port.value !== "number" ||
        !Number.isInteger(port.value) ||
        port.value < 1 ||
        port.value > 65_535
      )) {
        invalidContract(`${path}.port must be an integer from 1 through 65535 or null`);
      }
      normalized.port = port.value;
    }
    const stopPolicy = readContractField(report, "stopPolicy", path);
    if (stopPolicy.present) {
      if (stopPolicy.value !== null && !isRawPlainRecord(stopPolicy.value)) {
        invalidContract(`${path}.stopPolicy must be a plain, non-proxy object or null`);
      }
      normalized.stopPolicy = stopPolicy.value;
    }
    reports.push(normalized);
  }
  return reports;
}

function canonicalizeQuestion(value: unknown) {
  if (value === null) return null;
  const record = requirePlainContractRecord(value, "question");
  const prompt = readContractField(record, "prompt", "question", true).value;
  const choicesValue = readContractField(record, "choices", "question", true).value;
  const { array, length } = readContractArrayLength(choicesValue, "question.choices");
  const choices: Array<{ key: string; label: string; description?: string }> = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
    if (!descriptor || !("value" in descriptor)) {
      invalidContract(`question.choices[${index}] must be an own data property`);
    }
    const path = `question.choices[${index}]`;
    const choice = requirePlainContractRecord(descriptor.value, path);
    const key = readContractField(choice, "key", path, true).value;
    const label = readContractField(choice, "label", path, true).value;
    const description = readContractField(choice, "description", path);
    if (description.present && typeof description.value !== "string") {
      invalidContract(`${path}.description must be a string`);
    }
    choices.push({
      key: requireString(key, `${path}.key`),
      label: requireString(label, `${path}.label`),
      ...(description.present ? { description: description.value as string } : {}),
    });
  }
  return {
    prompt: requireString(prompt, "question.prompt"),
    choices,
  };
}

function canonicalizeOptionalField(field: AdapterExecutionResultField, value: unknown): unknown {
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
  if (nullableStringFields.includes(field)) {
    if (value !== null && typeof value !== "string") invalidContract(`${field} must be a string or null`);
    return value;
  }
  if (field === "errorFamily") {
    if (value !== null && value !== "transient_upstream" && value !== "model_refusal") {
      invalidContract("errorFamily has an invalid enum value");
    }
    return value;
  }
  if (field === "billingType") {
    if (value !== null && (typeof value !== "string" || ![
      "api",
      "subscription",
      "metered_api",
      "subscription_included",
      "subscription_overage",
      "credits",
      "fixed",
      "unknown",
    ].includes(value))) invalidContract("billingType has an invalid enum value");
    return value;
  }
  if (field === "costUsd") {
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      invalidContract("costUsd must be a finite non-negative number or null");
    }
    return value;
  }
  if (field === "clearSession") {
    if (typeof value !== "boolean") invalidContract("clearSession must be a boolean");
    return value;
  }
  if (field === "runtimeServices") return canonicalizeRuntimeServices(value);
  if (field === "question") return canonicalizeQuestion(value);
  if (field === "usage") return canonicalizeUsage(value);
  if (field === "sessionParams" || field === "resultJson") {
    if (value !== null && !isRawPlainRecord(value)) {
      invalidContract(`${field} must be a plain, non-proxy object or null`);
    }
    return value;
  }
  if (field === "errorMeta") {
    if (!isRawPlainRecord(value)) invalidContract("errorMeta must be a plain, non-proxy object");
    return value;
  }
  invalidContract(`${field} is not an optional adapter result field`);
}

const PRIORITIZED_OPTIONAL_FIELDS: readonly AdapterExecutionResultField[] = [
  "usage",
  "runtimeServices",
  "question",
  ...ADAPTER_EXECUTION_RESULT_FIELDS.slice(3).filter((field) =>
    field !== "usage" && field !== "runtimeServices" && field !== "question"),
];

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
  const normalizedExitCode = normalizeHeartbeatExitCodeForPersistence(rawExitCode);
  if (rawExitCode !== null && normalizedExitCode === null) {
    throw new InvalidAdapterExecutionResultError(
      "exitCode must fit PostgreSQL int4, be a Windows uint32 process code, or be null",
    );
  }
  if (rawSignal !== null && typeof rawSignal !== "string") {
    throw new InvalidAdapterExecutionResultError("signal must be a string or null");
  }
  if (typeof rawTimedOut !== "boolean") {
    throw new InvalidAdapterExecutionResultError("timedOut must be a boolean");
  }

  for (const field of ADAPTER_EXECUTION_RESULT_FIELDS.slice(3)) {
    const candidate = candidates.get(field);
    if (candidate?.present) candidate.value = canonicalizeOptionalField(field, candidate.value);
  }

  const state = createState();
  if (!consumeOutputBytes(state, 2)) invalidContract("root object exceeds persistence budget");
  const output: Record<string, unknown> = {};
  const storeField = (field: AdapterExecutionResultField, value: unknown, required = false) => {
    if (state.outputSlots >= MAX_OUTPUT_SLOTS) {
      if (required || field === "usage" || field === "runtimeServices" || field === "question") {
        invalidContract(`${field} could not be preserved within persistence limits`);
      }
      return;
    }
    const propertyBytes = (Object.keys(output).length > 0 ? 1 : 0) + jsonStringByteLength(field) + 1;
    if (!consumeOutputBytes(state, propertyBytes)) {
      if (required) invalidContract(`${field} exceeds persistence budget`);
      return;
    }
    const sanitized = sanitizeValue(value, state, 0);
    if (sanitized === OMIT) {
      state.outputBytes -= propertyBytes;
      if (required || field === "usage" || field === "runtimeServices" || field === "question") {
        invalidContract(`${field} could not be preserved within persistence limits`);
      }
      return;
    }
    const canonical = field === "exitCode" || field === "signal" || field === "timedOut"
      ? sanitized
      : canonicalizeOptionalField(field, sanitized);
    Object.defineProperty(output, field, {
      value: canonical,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    state.outputSlots += 1;
  };

  storeField("exitCode", normalizedExitCode, true);
  storeField("signal", rawSignal, true);
  storeField("timedOut", rawTimedOut, true);
  for (const field of PRIORITIZED_OPTIONAL_FIELDS) {
    const candidate = candidates.get(field);
    if (candidate?.present) storeField(field, candidate.value);
  }

  const encodedBytes = Buffer.byteLength(JSON.stringify(output), "utf8");
  if (encodedBytes > MAX_OUTPUT_BYTES) {
    throw new InvalidAdapterExecutionResultError(
      `serialized output exceeded ${MAX_OUTPUT_BYTES} bytes after sanitization`,
    );
  }
  return output as unknown as AdapterExecutionResult;
}
