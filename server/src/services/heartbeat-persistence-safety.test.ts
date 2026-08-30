import { describe, expect, it } from "vitest";
import {
  ADAPTER_EXECUTION_RESULT_FIELDS,
  InvalidAdapterExecutionResultError,
  normalizeAdapterExecutionResultForPersistence,
  sanitizeHeartbeatPersistenceRecord,
  sanitizeHeartbeatPersistenceText,
  sanitizeHeartbeatPersistenceValue,
} from "./heartbeat-persistence-safety.js";

describe("heartbeat persistence safety", () => {
  it("keeps the AdapterExecutionResult root contract at exactly 22 known fields", () => {
    expect(ADAPTER_EXECUTION_RESULT_FIELDS).toHaveLength(22);
    const input = Object.fromEntries(
      ADAPTER_EXECUTION_RESULT_FIELDS.map((field) => [field, null]),
    ) as Record<string, unknown>;
    input.exitCode = 0;
    input.signal = null;
    input.timedOut = false;
    input.unknown = "must not persist";

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
      billingType: { unexpected: true },
      resultJson: { nested, proxy },
      get unknown() {
        behaviorCalls += 1;
        return "no";
      },
    };

    const result = normalizeAdapterExecutionResultForPersistence(root);

    expect(behaviorCalls).toBe(0);
    expect(result).not.toHaveProperty("billingType");
    expect(result.resultJson).toEqual({ nested: { safe: "ok" }, proxy: null });
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

  it("sanitizes standalone text and omits non-JSON behavior", () => {
    expect(sanitizeHeartbeatPersistenceText("a\u0000b")).toBe("a\uFFFDb");
    expect(sanitizeHeartbeatPersistenceValue({ fn: () => "no", symbol: Symbol("no"), value: 1 }))
      .toEqual({ value: 1 });
  });
});
