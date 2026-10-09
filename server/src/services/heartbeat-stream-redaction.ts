import { stripVTControlCharacters } from "node:util";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import {
  sanitizeHeartbeatPersistenceText,
  sanitizeHeartbeatPersistenceValue,
} from "./heartbeat-persistence-safety.js";

export type HeartbeatLogStream = "stdout" | "stderr";
export type SafeHeartbeatLogChunk = { stream: HeartbeatLogStream; chunk: string };

export const HEARTBEAT_STREAM_REDACTION_MARKER =
  "[paperclip redacted ambiguous adapter log; channel suppressed]\n";
const RECORD_MARKER = "[paperclip redacted ambiguous structured log]\n";
export const HEARTBEAT_STREAM_REDACTION_LIMITS = Object.freeze({
  // UTF-16 code units; at most 256 KiB of UTF-8 per pending channel.
  maxBufferedCharsPerStream: 64 * 1024,
  maxInputCharsPerWrite: 64 * 1024,
  maxPendingLines: 128,
  maxOutputCharsPerWrite: 64 * 1024 + HEARTBEAT_STREAM_REDACTION_MARKER.length,
});

const IGNORABLE = /[\s\p{Cc}\p{Cf}\p{Cs}]/gu;
const SECRET_NAMES = [
  "apikey", "accesstoken", "auth", "authtoken", "token", "authorization",
  "bearer", "secret", "passwd", "password", "credential", "jwt",
  "privatekey", "cookie", "connectionstring",
];
const SECRET_NAME =
  "(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)";
const ASSIGNMENT = new RegExp(`${SECRET_NAME}[a-z0-9_-]*(?:["']|\\\\")?[:=]`, "i");
const CLI_FLAG = new RegExp(`-{1,2}[a-z0-9_-]*${SECRET_NAME}`, "i");
const BEARER = /bearer/i;
const NAME_PREFIXES = new Set(SECRET_NAMES.flatMap((name) =>
  Array.from({ length: name.length }, (_, index) => name.slice(0, index + 1))));

function classifierText(text: string) {
  return stripVTControlCharacters(text).normalize("NFKC").replace(IGNORABLE, "");
}

function hasSensitiveContext(text: string) {
  const dense = classifierText(text);
  return ASSIGNMENT.test(dense) || CLI_FLAG.test(dense) || BEARER.test(dense);
}

function mayContinueSensitiveName(text: string) {
  const tail = (classifierText(text).match(/[a-z0-9_-]+["']?$/i)?.[0] ?? "")
    .replace(/[-_"']/g, "").toLowerCase();
  // A line boundary is not a trustworthy delimiter in `to\nken=`. Hold
  // possible suffixes until the next complete line resolves the context.
  for (const prefix of NAME_PREFIXES) if (tail.endsWith(prefix)) return true;
  return false;
}

function cleanDisplayText(text: string) {
  return stripVTControlCharacters(text).replace(/\p{Cf}/gu, "")
    .replace(/[\u0000\p{Cs}]/gu, "\uFFFD");
}

// The first sanitizer bounds depth/nodes before this walk. A JSON record has
// an explicit end, but free-form strings / argv-like arrays inside it can
// still contain ambiguous secret assignments. Mask those entire values.
function guardStructuredStrings(value: unknown): unknown {
  if (typeof value === "string") {
    return hasSensitiveContext(value) ? REDACTED_EVENT_VALUE : cleanDisplayText(value);
  }
  if (Array.isArray(value)) {
    if (value.some((entry) => typeof entry === "string" && (
      hasSensitiveContext(entry) || SECRET_NAMES.some((name) =>
        classifierText(entry).replace(/[-_]/g, "").toLowerCase().endsWith(name))
    ))) return REDACTED_EVENT_VALUE;
    return value.map(guardStructuredStrings);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, entry] of Object.entries(value)) {
      const normalizedKey = stripVTControlCharacters(key).normalize("NFKC")
        .replace(IGNORABLE, "");
      if (Object.hasOwn(out, normalizedKey)) return REDACTED_EVENT_VALUE;
      out[normalizedKey] = guardStructuredStrings(entry);
    }
    return out;
  }
  return value;
}

type StreamState = {
  pending: string;
  pendingLines: number;
  firstPending: number;
  suppressed: boolean;
};

export type HeartbeatStreamRedactor = {
  write: (stream: HeartbeatLogStream, chunk: unknown) => SafeHeartbeatLogChunk[];
  /** Terminal only: close both channels, safely handle residuals, ignore late writes. */
  flush: () => SafeHeartbeatLogChunk[];
  pendingCharacters: () => Readonly<Record<HeartbeatLogStream, number>>;
};

/**
 * One instance per adapter execution. Feed every stdout/stderr write here BEFORE
 * excerpts, log-store append, event persistence, or live publication. Fan out
 * only the returned safe chunks, and serialize async sinks in the caller.
 *
 * Plaintext emits complete lines only. Valid complete JSON is reconstructed and
 * sanitized by value. Malformed/unfinished structured records remain buffered.
 * Sensitive unframed assignments, unsupported escapes, and resource overflows
 * suppress the affected channel until terminal flush: a newline cannot prove
 * where a hostile multiline secret ends. There is no timeout-based raw flush.
 *
 * Streams are independent. Completed records follow completion order; terminal
 * residuals follow their first pending write. flush() is idempotent and must run
 * BEFORE terminal snapshots and closing the run log (success/error/cancel).
 */
export function createHeartbeatStreamRedactor(options: {
  redactAdditionalText?: (safeText: string) => string;
} = {}): HeartbeatStreamRedactor {
  const makeState = (): StreamState => ({
    pending: "", pendingLines: 0, firstPending: 0, suppressed: false,
  });
  const states = { stdout: makeState(), stderr: makeState() };
  let closed = false;
  let sequence = 0;

  function resetPending(state: StreamState) {
    state.pending = "";
    state.pendingLines = 0;
    state.firstPending = 0;
  }

  function suppress(state: StreamState) {
    resetPending(state);
    state.suppressed = true;
    return HEARTBEAT_STREAM_REDACTION_MARKER;
  }

  function finishSafe(text: string): string {
    let safe = sanitizeHeartbeatPersistenceText(cleanDisplayText(text));
    if (options.redactAdditionalText) safe = options.redactAdditionalText(safe);
    if (typeof safe !== "string") throw new Error("invalid log redactor output");
    return sanitizeHeartbeatPersistenceText(cleanDisplayText(safe));
  }

  function takeRecord(state: StreamState, terminal: boolean): string | null {
    const raw = state.pending;
    // stripVTControlCharacters also accepts some control sequences spanning a
    // newline. Reject those BEFORE stripping: consuming the next key character
    // could turn `api ESC[ LF Key=` into an apparently harmless assignment.
    const withoutCompleteCsi = raw.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
    if (/[\u001b\u0090\u009b\u009d]/u.test(withoutCompleteCsi)) {
      return suppress(state);
    }
    const unstyled = stripVTControlCharacters(raw);
    // Incomplete ANSI/OSC sequences may hide a delimiter or span multiple
    // lines. Do not treat the unparsed remainder as harmless printable text.
    if (unstyled.includes("\u001b") || /[\u0090\u009b\u009d]/u.test(unstyled)) {
      return suppress(state);
    }
    let parsed: unknown;
    let structured = false;
    try { parsed = JSON.parse(unstyled); structured = true; } catch { /* not complete JSON */ }
    if (structured) {
      resetPending(state);
      try {
        const bounded = sanitizeHeartbeatPersistenceValue(parsed);
        const guarded = guardStructuredStrings(bounded);
        const safe = sanitizeHeartbeatPersistenceValue(guarded);
        return finishSafe(`${JSON.stringify(safe)}\n`);
      } catch { return suppress(state); }
    }
    // Includes pretty JSON and strings whose closing quote has not arrived.
    const looksStructured = /^\s*(?:\{|"|\[\s*(?:[\[{"\d\-\]]|true|false|null|$))/u.test(unstyled);
    if (looksStructured) {
      if (terminal) return suppress(state);
      return null;
    }
    if (hasSensitiveContext(unstyled)) return suppress(state);
    if (mayContinueSensitiveName(unstyled)) {
      if (terminal) return suppress(state);
      return null;
    }
    // A terminal unterminated ordinary line is safe only after the same full
    // context checks, never because shutdown/error made a raw flush convenient.
    resetPending(state);
    try { return finishSafe(unstyled); } catch { return suppress(state); }
  }

  function write(stream: HeartbeatLogStream, chunk: unknown): SafeHeartbeatLogChunk[] {
    if (closed || (stream !== "stdout" && stream !== "stderr")) return [];
    const state = states[stream];
    if (state.suppressed || chunk === "") return [];
    if (typeof chunk !== "string" || chunk.length > HEARTBEAT_STREAM_REDACTION_LIMITS.maxInputCharsPerWrite) {
      return [{ stream, chunk: suppress(state) }];
    }
    let output = "";
    let cursor = 0;
    while (cursor < chunk.length && !state.suppressed) {
      const newline = chunk.indexOf("\n", cursor);
      const end = newline < 0 ? chunk.length : newline + 1;
      const length = end - cursor;
      if (state.pending.length + length > HEARTBEAT_STREAM_REDACTION_LIMITS.maxBufferedCharsPerStream) {
        output += suppress(state);
        break;
      }
      if (!state.pending) state.firstPending = ++sequence;
      state.pending += chunk.slice(cursor, end);
      cursor = end;
      if (newline < 0) break;
      if (++state.pendingLines > HEARTBEAT_STREAM_REDACTION_LIMITS.maxPendingLines) {
        output += suppress(state);
        break;
      }
      const safe = takeRecord(state, false);
      if (safe !== null) {
        if (output.length + safe.length > HEARTBEAT_STREAM_REDACTION_LIMITS.maxBufferedCharsPerStream) {
          output += suppress(state);
          break;
        }
        output += safe;
      }
    }
    return output ? [{ stream, chunk: output }] : [];
  }

  function flush(): SafeHeartbeatLogChunk[] {
    if (closed) return [];
    closed = true;
    const streams: HeartbeatLogStream[] = ["stdout", "stderr"];
    streams.sort((a, b) => states[a].firstPending - states[b].firstPending);
    const output: SafeHeartbeatLogChunk[] = [];
    for (const stream of streams) {
      const state = states[stream];
      if (state.suppressed || !state.pending) continue;
      const safe = takeRecord(state, true) ?? RECORD_MARKER;
      output.push({ stream, chunk: safe.length <= HEARTBEAT_STREAM_REDACTION_LIMITS.maxOutputCharsPerWrite
        ? safe : suppress(state) });
    }
    return output;
  }

  return { write, flush, pendingCharacters: () => ({
    stdout: states.stdout.pending.length, stderr: states.stderr.pending.length,
  }) };
}
