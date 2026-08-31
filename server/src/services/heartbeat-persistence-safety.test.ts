import { describe, expect, it } from "vitest";
import {
  ADAPTER_EXECUTION_RESULT_FIELDS,
  HEARTBEAT_PERSISTENCE_LIMITS,
  InvalidAdapterExecutionResultError,
  normalizeAdapterExecutionResultForPersistence,
  normalizeHeartbeatExitCodeForPersistence,
  sanitizeHeartbeatPersistenceRecord,
  sanitizeHeartbeatPersistenceText,
  sanitizeHeartbeatPersistenceValue,
} from "./heartbeat-persistence-safety.js";

describe("heartbeat persistence safety", () => {
  it("keeps the AdapterExecutionResult root contract at exactly 22 known fields", () => {
    expect(ADAPTER_EXECUTION_RESULT_FIELDS).toHaveLength(22);
    const input = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      unknown: "must not persist",
    };

    const result = normalizeAdapterExecutionResultForPersistence(input);

    expect(Object.keys(result)).not.toContain("unknown");
    expect(Object.keys(result).every((field) =>
      ADAPTER_EXECUTION_RESULT_FIELDS.includes(field as (typeof ADAPTER_EXECUTION_RESULT_FIELDS)[number]))).toBe(true);
  });

  it("removes U+0000 recursively from values and keys without prototype collisions", () => {
    const input = Object.create(null) as Record<string, unknown>;
    input["key\u0000"] = "value\u0000";
    input["key\uFFFD"] = { nested: ["a\u0000b"] };
    input.__proto__ = "plain data";

    const result = sanitizeHeartbeatPersistenceRecord(input);
    const encoded = JSON.stringify(result);

    expect(encoded).not.toContain("\u0000");
    expect(result["key\uFFFD"]).toBe("value\uFFFD");
    expect(result["key\uFFFD [collision 2]"]).toEqual({ nested: ["a\uFFFDb"] });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(true);
    expect(result.__proto__).toBe("plain data");
  });

  it("handles dates, boxed primitives, cycles, hostile arrays, and odd prototypes", () => {
    let arrayGetterCalls = 0;
    const hostileArray: unknown[] = ["safe"];
    Object.defineProperty(hostileArray, "1", {
      enumerable: true,
      get() {
        arrayGetterCalls += 1;
        return "must not run";
      },
    });
    hostileArray.length = 2;

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const odd = Object.create({ inherited: "ignored" }) as Record<string, unknown>;
    odd.value = "ignored";

    const result = sanitizeHeartbeatPersistenceRecord({
      date: new Date("2026-08-30T12:00:00.000Z"),
      invalidDate: new Date(Number.NaN),
      fakeDate: Object.create(Date.prototype),
      boxedString: new String("boxed\u0000"),
      fakeBoxedString: Object.create(String.prototype),
      boxedNumber: new Number(4),
      boxedBoolean: new Boolean(false),
      cycle,
      hostileArray,
      odd,
    });

    expect(arrayGetterCalls).toBe(0);
    expect(result).toMatchObject({
      date: "2026-08-30T12:00:00.000Z",
      invalidDate: null,
      fakeDate: null,
      boxedString: "boxed\uFFFD",
      fakeBoxedString: null,
      boxedNumber: 4,
      boxedBoolean: false,
      cycle: { self: "[Circular]" },
      hostileArray: ["safe", null],
      odd: null,
    });
  });

  it("does not execute getters, toJSON, proxy traps, or unknown root fields", () => {
    let behaviorCalls = 0;
    const nested = {
      safe: "ok",
      get getter() {
        behaviorCalls += 1;
        return "no";
      },
      toJSON() {
        behaviorCalls += 1;
        return { leaked: true };
      },
    };
    Object.defineProperty(nested, "hidden", {
      enumerable: false,
      value: "must preserve JSON omission semantics",
    });
    const proxy = new Proxy({ secret: "no" }, {
      get() {
        behaviorCalls += 1;
        return "no";
      },
      ownKeys() {
        behaviorCalls += 1;
        return [];
      },
      getOwnPropertyDescriptor() {
        behaviorCalls += 1;
        return undefined;
      },
      getPrototypeOf() {
        behaviorCalls += 1;
        return Object.prototype;
      },
    });
    const root = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      resultJson: { nested, proxy },
      get unknown() {
        behaviorCalls += 1;
        return "no";
      },
    };

    const result = normalizeAdapterExecutionResultForPersistence(root);

    expect(behaviorCalls).toBe(0);
    expect(result.resultJson).toEqual({ nested: { safe: "ok" }, proxy: null });
  });

  it("rejects every accessor-backed known field without executing its getter", () => {
    for (const field of ADAPTER_EXECUTION_RESULT_FIELDS) {
      let getterCalls = 0;
      const input: Record<string, unknown> = { exitCode: 0, signal: null, timedOut: false };
      Object.defineProperty(input, field, {
        configurable: true,
        enumerable: true,
        get() {
          getterCalls += 1;
          return null;
        },
      });

      expect(() => normalizeAdapterExecutionResultForPersistence(input), field)
        .toThrow(InvalidAdapterExecutionResultError);
      expect(getterCalls, field).toBe(0);
    }
  });

  it("rejects Date and boxed values before sanitizing required and scalar optional fields", () => {
    const requiredCases: Array<[string, unknown]> = [
      ["exitCode boxed", { exitCode: new Number(0), signal: null, timedOut: false }],
      ["exitCode Date", { exitCode: new Date(), signal: null, timedOut: false }],
      ["signal boxed", { exitCode: 0, signal: new String("SIGTERM"), timedOut: false }],
      ["signal Date", { exitCode: 0, signal: new Date(), timedOut: false }],
      ["timedOut boxed", { exitCode: 0, signal: null, timedOut: new Boolean(false) }],
      ["timedOut Date", { exitCode: 0, signal: null, timedOut: new Date() }],
    ];
    for (const [label, input] of requiredCases) {
      expect(() => normalizeAdapterExecutionResultForPersistence(input), label)
        .toThrow(InvalidAdapterExecutionResultError);
    }

    const scalarOptionalCases: Array<[string, unknown]> = [
      ...[
        "errorMessage",
        "errorCode",
        "retryNotBefore",
        "sessionId",
        "sessionDisplayId",
        "provider",
        "biller",
        "model",
        "summary",
      ].flatMap((field) => [
        [`${field} boxed`, { field, value: new String("value") }],
        [`${field} Date`, { field, value: new Date() }],
      ] as Array<[string, { field: string; value: unknown }]>),
      ["errorFamily boxed", { field: "errorFamily", value: new String("model_refusal") }],
      ["errorFamily Date", { field: "errorFamily", value: new Date() }],
      ["billingType boxed", { field: "billingType", value: new String("api") }],
      ["billingType Date", { field: "billingType", value: new Date() }],
      ["costUsd boxed", { field: "costUsd", value: new Number(1) }],
      ["costUsd Date", { field: "costUsd", value: new Date() }],
      ["clearSession boxed", { field: "clearSession", value: new Boolean(false) }],
      ["clearSession Date", { field: "clearSession", value: new Date() }],
    ];
    for (const [label, testCase] of scalarOptionalCases as Array<[
      string,
      { field: string; value: unknown },
    ]>) {
      expect(() => normalizeAdapterExecutionResultForPersistence({
        exitCode: 0,
        signal: null,
        timedOut: false,
        [testCase.field]: testCase.value,
      }), label).toThrow(InvalidAdapterExecutionResultError);
    }
  });

  it("rejects every present optional field whose raw type is invalid", () => {
    const invalidValues: Partial<Record<(typeof ADAPTER_EXECUTION_RESULT_FIELDS)[number], unknown>> = {
      errorMessage: 1,
      errorCode: false,
      errorFamily: "other",
      retryNotBefore: 1,
      errorMeta: [],
      usage: null,
      sessionId: 1,
      sessionParams: [],
      sessionDisplayId: 1,
      provider: 1,
      biller: 1,
      model: 1,
      billingType: "other",
      costUsd: Number.NaN,
      resultJson: [],
      runtimeServices: {},
      summary: 1,
      clearSession: null,
      question: [],
    };

    for (const [field, value] of Object.entries(invalidValues)) {
      expect(() => normalizeAdapterExecutionResultForPersistence({
        exitCode: 0,
        signal: null,
        timedOut: false,
        [field]: value,
      }), field).toThrow(InvalidAdapterExecutionResultError);
    }
  });

  it("rejects invalid usage, question, and runtime-service contracts recursively", () => {
    const invalidCases: Array<[string, Record<string, unknown>]> = [
      ["usage missing required totals", { usage: {} }],
      ["usage negative input", { usage: { inputTokens: -1, outputTokens: 0 } }],
      ["usage non-finite output", { usage: { inputTokens: 0, outputTokens: Number.NaN } }],
      ["question missing prompt and choices", { question: {} }],
      ["question choices is not an array", { question: { prompt: "Continue?", choices: {} } }],
      ["question choice missing label", {
        question: { prompt: "Continue?", choices: [{ key: "yes" }] },
      }],
      ["runtime service missing serviceName", { runtimeServices: [{}] }],
      ["runtime service has invalid status", {
        runtimeServices: [{ serviceName: "preview", status: "ready" }],
      }],
      ["runtime service has invalid port", {
        runtimeServices: [{ serviceName: "preview", port: -1 }],
      }],
    ];

    for (const [label, extra] of invalidCases) {
      expect(() => normalizeAdapterExecutionResultForPersistence({
        exitCode: 0,
        signal: null,
        timedOut: false,
        ...extra,
      }), label).toThrow(InvalidAdapterExecutionResultError);
    }
  });

  it("rejects nested contract accessors without executing them", () => {
    for (const [label, build] of [
      ["usage", (getter: () => unknown) => {
        const usage = { outputTokens: 0 } as Record<string, unknown>;
        Object.defineProperty(usage, "inputTokens", { enumerable: true, get: getter });
        return { usage };
      }],
      ["question choice", (getter: () => unknown) => {
        const choice = { key: "yes" } as Record<string, unknown>;
        Object.defineProperty(choice, "label", { enumerable: true, get: getter });
        return { question: { prompt: "Continue?", choices: [choice] } };
      }],
      ["runtime service", (getter: () => unknown) => {
        const service = { serviceName: "preview" } as Record<string, unknown>;
        Object.defineProperty(service, "status", { enumerable: true, get: getter });
        return { runtimeServices: [service] };
      }],
    ] as const) {
      let getterCalls = 0;
      const extra = build(() => {
        getterCalls += 1;
        return "must not run";
      });
      expect(() => normalizeAdapterExecutionResultForPersistence({
        exitCode: 0,
        signal: null,
        timedOut: false,
        ...extra,
      }), label).toThrow(InvalidAdapterExecutionResultError);
      expect(getterCalls, label).toBe(0);
    }
  });

  it("strictly rejects missing, accessor-backed, and wrongly typed required fields", () => {
    let getterCalls = 0;
    const accessorBacked = { signal: null, timedOut: false } as Record<string, unknown>;
    Object.defineProperty(accessorBacked, "exitCode", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 0;
      },
    });

    expect(() => normalizeAdapterExecutionResultForPersistence(accessorBacked))
      .toThrow(InvalidAdapterExecutionResultError);
    expect(getterCalls).toBe(0);
    expect(() => normalizeAdapterExecutionResultForPersistence({ exitCode: 0, signal: null }))
      .toThrow(/timedOut/);
    expect(() => normalizeAdapterExecutionResultForPersistence({ exitCode: "0", signal: null, timedOut: false }))
      .toThrow(/exitCode/);
  });

  it("maps unsigned Windows process codes into PostgreSQL int4 without hiding invalid values", () => {
    expect(normalizeHeartbeatExitCodeForPersistence(3_221_226_505)).toBe(-1_073_740_791);
    expect(normalizeHeartbeatExitCodeForPersistence(2_147_483_648)).toBe(-2_147_483_648);
    expect(normalizeHeartbeatExitCodeForPersistence(4_294_967_295)).toBe(-1);
    expect(normalizeHeartbeatExitCodeForPersistence(-2_147_483_648)).toBe(-2_147_483_648);
    expect(normalizeHeartbeatExitCodeForPersistence(2_147_483_647)).toBe(2_147_483_647);
    expect(normalizeHeartbeatExitCodeForPersistence(4_294_967_296)).toBeNull();
    expect(normalizeHeartbeatExitCodeForPersistence(-2_147_483_649)).toBeNull();
    expect(normalizeHeartbeatExitCodeForPersistence(1.5)).toBeNull();
    expect(normalizeHeartbeatExitCodeForPersistence(Number.NaN)).toBeNull();
    expect(normalizeHeartbeatExitCodeForPersistence(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeHeartbeatExitCodeForPersistence(Number.NEGATIVE_INFINITY)).toBeNull();

    expect(normalizeAdapterExecutionResultForPersistence({
      exitCode: 3_221_226_505,
      signal: null,
      timedOut: false,
    }).exitCode).toBe(-1_073_740_791);
    expect(() => normalizeAdapterExecutionResultForPersistence({
      exitCode: 4_294_967_296,
      signal: null,
      timedOut: false,
    })).toThrow(/PostgreSQL int4/);
  });

  it("rejects a proxy root without triggering its traps", () => {
    let trapCalls = 0;
    const proxy = new Proxy({ exitCode: 0, signal: null, timedOut: false }, {
      getPrototypeOf() {
        trapCalls += 1;
        return Object.prototype;
      },
      getOwnPropertyDescriptor() {
        trapCalls += 1;
        return undefined;
      },
    });

    expect(() => normalizeAdapterExecutionResultForPersistence(proxy)).toThrow(/non-proxy/);
    expect(trapCalls).toBe(0);
  });

  it("bounds work and output globally and does not rematerialize shared references", () => {
    const shared = Array.from({ length: 2_000 }, (_, index) => `leaf-${index}`);
    const fanOut = Object.fromEntries(
      Array.from({ length: 2_000 }, (_, index) => [`copy-${index}`, shared]),
    );
    const result = normalizeAdapterExecutionResultForPersistence({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMeta: { fanOut },
      usage: { inputTokens: 1, outputTokens: 2 },
      resultJson: { fanOut },
      sessionParams: { fanOut },
      question: { prompt: "Continue?", choices: [{ key: "yes", label: "Yes" }] },
    });
    const encoded = JSON.stringify(result);
    const countSlots = (value: unknown): number => {
      if (!value || typeof value !== "object") return 0;
      if (Array.isArray(value)) {
        return value.length + value.reduce((total, entry) => total + countSlots(entry), 0);
      }
      return Object.entries(value).reduce(
        (total, [, entry]) => total + 1 + countSlots(entry),
        0,
      );
    };

    expect(encoded).toContain("[Shared reference]");
    expect(countSlots(result)).toBeLessThanOrEqual(HEARTBEAT_PERSISTENCE_LIMITS.maxOutputSlots);
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(
      HEARTBEAT_PERSISTENCE_LIMITS.maxOutputBytes,
    );
  });

  it("budgets serialized JSON bytes including distributed escapes and separators", () => {
    const escapedChunks = Array.from(
      { length: 16 },
      () => "\u0001\"\\".repeat(80_000),
    );

    const result = normalizeAdapterExecutionResultForPersistence({
      exitCode: 0,
      signal: null,
      timedOut: false,
      resultJson: { escapedChunks },
    });
    const encodedBytes = Buffer.byteLength(JSON.stringify(result), "utf8");

    expect(encodedBytes).toBeLessThanOrEqual(HEARTBEAT_PERSISTENCE_LIMITS.maxOutputBytes);
    expect(JSON.stringify(result)).not.toContain("\u0000");
  });

  it("caps pre-cutoff work and allocation for huge strings and wide objects", () => {
    const hugeString = "safe-text-".repeat(3_000_000);
    const wide = Object.create(null) as Record<string, unknown>;
    for (let index = 0; index < 100_000; index += 1) wide[`key-${index}`] = index;
    const heapBefore = process.memoryUsage().heapUsed;
    const startedAt = performance.now();

    const result = sanitizeHeartbeatPersistenceRecord({ hugeString, wide });

    const elapsedMs = performance.now() - startedAt;
    const allocatedBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(allocatedBytes).toBeLessThan(128 * 1024 * 1024);
    expect(Object.keys(result.wide as Record<string, unknown>).length)
      .toBeLessThanOrEqual(HEARTBEAT_PERSISTENCE_LIMITS.maxObjectKeys);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8"))
      .toBeLessThanOrEqual(HEARTBEAT_PERSISTENCE_LIMITS.maxOutputBytes);
  });

  it("redacts synthetic secrets structurally and textually before persistence", () => {
    const syntheticSentinel = "sk-syntheticfixture123456789";
    const result = normalizeAdapterExecutionResultForPersistence({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `token=${syntheticSentinel}`,
      resultJson: {
        apiKey: syntheticSentinel,
        nested: { text: `Authorization: Bearer ${syntheticSentinel}` },
        commandArgs: ["--api-key", syntheticSentinel, "safe-next"],
      },
    });
    const encoded = JSON.stringify(result);

    expect(encoded).not.toContain(syntheticSentinel);
    expect(encoded).toContain("***REDACTED***");
    expect(result.resultJson).toMatchObject({
      apiKey: "***REDACTED***",
      commandArgs: ["--api-key", "***REDACTED***", "safe-next"],
    });
  });

  it("sanitizes standalone text and omits non-JSON behavior", () => {
    expect(sanitizeHeartbeatPersistenceText("a\u0000b")).toBe("a\uFFFDb");
    expect(sanitizeHeartbeatPersistenceValue({ fn: () => "no", symbol: Symbol("no"), value: 1 }))
      .toEqual({ value: 1 });
  });
});
