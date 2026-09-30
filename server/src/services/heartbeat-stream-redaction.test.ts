import { describe, expect, it } from "vitest";
import {
  createHeartbeatStreamRedactor,
  HEARTBEAT_STREAM_REDACTION_LIMITS as LIMITS,
  HEARTBEAT_STREAM_REDACTION_MARKER as MARKER,
  type SafeHeartbeatLogChunk,
} from "./heartbeat-stream-redaction.js";

// Synthetic and deliberately opaque: no sk-/JWT/provider-shaped pattern can
// accidentally make a chunk-local sanitizer pass this regression.
const CANARY = "w4tR9mQ7zP2dL8nV6cH5bS3fJ1xA0";
const dense = (text: string) => text.normalize("NFKC").replace(/[\s\p{Cc}\p{Cf}\p{Cs}]/gu, "");
const joined = (chunks: SafeHeartbeatLogChunk[]) => chunks.map(({ chunk }) => chunk).join("");
function expectNoCanary(chunks: SafeHeartbeatLogChunk[]) {
  // Boolean assertions do not print the canary or captured logs on failure.
  expect(dense(joined(chunks)).includes(CANARY)).toBe(false);
  expect(joined(chunks).includes("\u0000")).toBe(false);
}

describe("heartbeat stream redaction", () => {
  it("buffers raw fragments, emits ordinary complete lines, and safely flushes a residual", () => {
    const redactor = createHeartbeatStreamRedactor();
    expect(redactor.write("stdout", "compile rea")).toEqual([]);
    expect(redactor.write("stdout", "dy\nnext step")).toEqual([
      { stream: "stdout", chunk: "compile ready\n" },
    ]);
    // A potential sensitive-name prefix at the end must not be blindly flushed.
    expect(redactor.flush()).toEqual([{ stream: "stdout", chunk: MARKER }]);
    expect(redactor.flush()).toEqual([]);
    expect(redactor.write("stdout", "late adapter output\n")).toEqual([]);
  });

  it("blocks an opaque secret at EVERY split offset, on either channel", () => {
    const obfuscated = `${CANARY.slice(0, 9)}\u0000\u200b${CANARY.slice(9)}`;
    const cases = [
      `token=${CANARY}\n`, `token: ${CANARY}\n`,
      `to\nken=${CANARY}\n`, `t\no\nk\ne\nn=${CANARY}\n`,
      `api\u200bKey=\n${CANARY}\n`, `password:\r\n${CANARY}\n`,
      `--api-key\n${CANARY}\n`, `--token ${CANARY}\n`,
      `Authorization: Bearer ${CANARY}\n`,
      `api\u001b[31mKey\u001b[0m=${CANARY}\n`,
      `token=\u001b[32m${CANARY}\u001b[0m\n`,
      `ｔｏｋｅｎ＝${CANARY}\n`, `to\u2028ken=\n${CANARY}\n`,
      `to\u0000ken=${obfuscated}\n`, `token="${CANARY}\nmore text"\n`,
      `token=${CANARY.slice(0, 12)}\n${CANARY.slice(12)}\n`,
    ];
    for (const stream of ["stdout", "stderr"] as const) {
      for (const text of cases) {
        for (let split = 0; split <= text.length; split++) {
          const redactor = createHeartbeatStreamRedactor();
          const output = [
            ...redactor.write(stream, text.slice(0, split)),
            ...redactor.write(stream, text.slice(split)),
            ...redactor.flush(),
          ];
          expectNoCanary(output);
          expect(joined(output).includes("redacted")).toBe(true);
          expect(output.every((entry) => entry.stream === stream)).toBe(true);
        }
      }
    }
  });

  it("handles one-character writes without emitting a raw value or terminal suffix", () => {
    const redactor = createHeartbeatStreamRedactor();
    const output: SafeHeartbeatLogChunk[] = [];
    for (const char of `api\u200bKey=\n${CANARY}\n${CANARY}\n`) {
      output.push(...redactor.write("stdout", char));
      expectNoCanary(output);
    }
    output.push(...redactor.flush());
    expectNoCanary(output);
    expect(output).toEqual([{ stream: "stdout", chunk: MARKER }]);
  });

  it("never trusts newline as the end of an unframed secret value", () => {
    const redactor = createHeartbeatStreamRedactor();
    const output = redactor.write("stdout", "token=first-part\n");
    output.push(...redactor.write("stdout", `${CANARY}\n\nnormal-looking footer\n`));
    output.push(...redactor.flush());
    expect(output).toEqual([{ stream: "stdout", chunk: MARKER }]);
    expectNoCanary(output);
  });

  it("keeps the other channel independent and preserves completion order", () => {
    const redactor = createHeartbeatStreamRedactor();
    expect(redactor.write("stdout", "compile ")).toEqual([]);
    expect(redactor.write("stderr", `token=${CANARY}\n`)).toEqual([
      { stream: "stderr", chunk: MARKER },
    ]);
    expect(redactor.write("stdout", "ready\n")).toEqual([
      { stream: "stdout", chunk: "compile ready\n" },
    ]);
    expect(redactor.write("stderr", `${CANARY}\n`)).toEqual([]);
    expect(redactor.write("stdout", "all done\n")).toEqual([
      { stream: "stdout", chunk: "all done\n" },
    ]);
  });

  it("flushes residuals in first-pending order and is idempotent for end/error/cancel", () => {
    for (const reason of ["end", "error", "cancel"]) {
      const redactor = createHeartbeatStreamRedactor();
      redactor.write("stderr", `${reason} ready`);
      redactor.write("stdout", "done");
      expect(redactor.flush()).toEqual([
        { stream: "stderr", chunk: `${reason} ready` },
        { stream: "stdout", chunk: "done" },
      ]);
      expect(redactor.pendingCharacters()).toEqual({ stdout: 0, stderr: 0 });
      expect(redactor.flush()).toEqual([]);
      expect(redactor.write("stderr", `token=${CANARY}\n`)).toEqual([]);
    }
  });

  it("sanitizes complete structured records and does not suppress their following records", () => {
    const records = [
      { token: CANARY, status: "ready" },
      { ["to\u0000ken"]: CANARY, status: "ready" },
      { ["api\u001b[31mKey\u001b[0m"]: CANARY, status: "ready" },
      { ["to\nken"]: CANARY, status: "ready" },
      { ["ｐａｓｓｗｏｒｄ"]: CANARY, status: "ready" },
      { message: `apiKey=\n${CANARY}` },
      { argv: ["--token", CANARY] },
      ["--api-key", CANARY],
      { extra: { values: ["token=", CANARY] } },
    ];
    for (const record of records) {
      const text = `${JSON.stringify(record, null, 2)}\n`;
      for (let split = 0; split <= text.length; split++) {
        const redactor = createHeartbeatStreamRedactor();
        const output = [
          ...redactor.write("stdout", text.slice(0, split)),
          ...redactor.write("stdout", text.slice(split)),
        ];
        expectNoCanary(output);
        expect(joined(output).includes("REDACTED")).toBe(true);
        expect(redactor.write("stdout", '{"status":"ready"}\n')).toEqual([
          { stream: "stdout", chunk: '{"status":"ready"}\n' },
        ]);
      }
    }
  });

  it("preserves benign structured values including Unicode and empty values", () => {
    const value = { status: "ready", text: "mañana 🚀", items: ["alpha", "done"], empty: "", nil: null };
    const redactor = createHeartbeatStreamRedactor();
    const text = `${JSON.stringify(value)}\n`;
    const surrogate = text.indexOf("🚀") + 1;
    const output = [
      ...redactor.write("stdout", text.slice(0, surrogate)),
      ...redactor.write("stdout", text.slice(surrogate)),
    ];
    expect(JSON.parse(joined(output))).toEqual(value);
  });

  it("fails closed on malformed/unfinished JSON and split ANSI/OSC escapes", () => {
    const cases = [
      `{"token":"${CANARY}`, `{"to\nken":"${CANARY}"}\n`,
      `\u001b]0;token=${CANARY}\n`, `api\u001b[\nKey=${CANARY}\n`,
    ];
    for (const text of cases) {
      const redactor = createHeartbeatStreamRedactor();
      const output = [...redactor.write("stdout", text), ...redactor.flush()];
      expectNoCanary(output);
      expect(joined(output).includes("redacted")).toBe(true);
    }
  });

  it("strips complete ANSI sequences and does not emit NUL or lone surrogates", () => {
    const redactor = createHeartbeatStreamRedactor();
    expect(redactor.write("stdout", "\u001b[32mready\u001b[0m\u0000\ud800\n")).toEqual([
      { stream: "stdout", chunk: "ready\uFFFD\uFFFD\n" },
    ]);
  });

  it("bounds pending memory, oversized writes, and suppression markers", () => {
    const redactor = createHeartbeatStreamRedactor();
    redactor.write("stdout", "x".repeat(LIMITS.maxBufferedCharsPerStream));
    expect(redactor.pendingCharacters().stdout).toBe(LIMITS.maxBufferedCharsPerStream);
    expect(redactor.write("stdout", `token=${CANARY}\n`)).toEqual([
      { stream: "stdout", chunk: MARKER },
    ]);
    expect(redactor.pendingCharacters().stdout).toBe(0);
    expect(redactor.write("stdout", "x".repeat(LIMITS.maxInputCharsPerWrite + 1))).toEqual([]);
    const other = createHeartbeatStreamRedactor();
    expect(other.write("stderr", "x".repeat(LIMITS.maxInputCharsPerWrite + 1))).toEqual([
      { stream: "stderr", chunk: MARKER },
    ]);
    expect(other.pendingCharacters()).toEqual({ stdout: 0, stderr: 0 });
  });

  it("bounds multiline scanning and output even under many writes or many empty lines", () => {
    const redactor = createHeartbeatStreamRedactor();
    const output: SafeHeartbeatLogChunk[] = [];
    for (let index = 0; index < LIMITS.maxPendingLines + 2; index++) {
      output.push(...redactor.write("stdout", index ? "\n" : "{\n"));
    }
    expect(output).toEqual([{ stream: "stdout", chunk: MARKER }]);
    expect(redactor.pendingCharacters().stdout).toBe(0);
    const emptyLines = createHeartbeatStreamRedactor().write("stdout", "\n".repeat(LIMITS.maxInputCharsPerWrite));
    expect(emptyLines.length).toBeLessThanOrEqual(1);
    expect(joined(emptyLines).length).toBeLessThanOrEqual(LIMITS.maxOutputCharsPerWrite);
  });

  it("rejects hostile nonstrings without invoking conversions or getters", () => {
    let calls = 0;
    const hostile = { toString() { calls++; return CANARY; } };
    const redactor = createHeartbeatStreamRedactor();
    expect(redactor.write("stdout", hostile)).toEqual([{ stream: "stdout", chunk: MARKER }]);
    expect(calls).toBe(0);
    expect(redactor.flush()).toEqual([]);
  });

  it("only invokes additional redaction with already-safe text and hides callback errors", () => {
    let called = 0;
    const redactor = createHeartbeatStreamRedactor({ redactAdditionalText: (safe) => {
      called++;
      expect(dense(safe).includes(CANARY)).toBe(false);
      return safe.replace("ordinary-user", "[user]");
    } });
    expect(redactor.write("stdout", '{"user":"ordinary-user"}\n')).toEqual([
      { stream: "stdout", chunk: '{"user":"[user]"}\n' },
    ]);
    expectNoCanary(redactor.write("stdout", `{"token":"${CANARY}"}\n`));
    expect(called).toBe(2);
    const failing = createHeartbeatStreamRedactor({ redactAdditionalText: () => { throw new Error(CANARY); } });
    expect(failing.write("stdout", "ready\n")).toEqual([{ stream: "stdout", chunk: MARKER }]);
  });
});
