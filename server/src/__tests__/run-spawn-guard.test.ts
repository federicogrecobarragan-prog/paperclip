import { describe, expect, it, vi } from "vitest";
import { createRunSpawnGuard, matchesRecordedProcessBirth } from "../services/run-spawn-guard.js";

const metadata = { pid: 12345, processGroupId: null, startedAt: "2026-01-01T00:00:01.000Z" };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
describe("conditional spawn admission", () => {
  it("kills a late child after cancellation while the fake adapter is awaiting spawn", async () => {
    let cancelled = false;
    const persist = vi.fn(async () => true);
    const terminate = vi.fn(async () => {});
    const guard = createRunSpawnGuard({ cancelled: () => cancelled,
      claimActive: async () => true, persistActive: persist, terminate });
    expect(await guard.prepare()).toBe(true);
    const spawn = deferred();
    const adapter = (async () => { await spawn.promise; return guard.admitSpawn(metadata); })();
    cancelled = true; // No PID existed when cancel returned.
    spawn.resolve();
    expect(await adapter).toBe(false);
    expect(persist).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalledExactlyOnceWith(metadata);
  });
  it("honors database cancellation from another service instance", async () => {
    const terminate = vi.fn(async () => {});
    const guard = createRunSpawnGuard({ cancelled: () => false,
      claimActive: async () => true, persistActive: async () => false, terminate });
    expect(await guard.admitSpawn(metadata)).toBe(false);
    expect(terminate).toHaveBeenCalledExactlyOnceWith(metadata);
  });
  it("kills the newborn when cancellation races an awaited persistence", async () => {
    let cancelled = false;
    const saved = deferred();
    const terminate = vi.fn(async () => {});
    const guard = createRunSpawnGuard({ cancelled: () => cancelled,
      claimActive: async () => true, persistActive: async () => { await saved.promise; return true; }, terminate });
    const admitted = guard.admitSpawn(metadata);
    cancelled = true;
    saved.resolve();
    expect(await admitted).toBe(false);
    expect(terminate).toHaveBeenCalledOnce();
  });
  it("rejects a cancelled database claim before execute", async () => {
    const guard = createRunSpawnGuard({ cancelled: () => false,
      claimActive: async () => false, persistActive: async () => true, terminate: async () => {} });
    expect(await guard.prepare()).toBe(false);
  });
  it("does not kill an admitted active child", async () => {
    const terminate = vi.fn(async () => {});
    const guard = createRunSpawnGuard({ cancelled: () => false,
      claimActive: async () => true, persistActive: async () => true, terminate });
    expect(await guard.admitSpawn(metadata)).toBe(true);
    expect(terminate).not.toHaveBeenCalled();
  });
  it("fails closed on a persistence exception", async () => {
    const terminate = vi.fn(async () => {});
    const guard = createRunSpawnGuard({ cancelled: () => false,
      claimActive: async () => true, persistActive: async () => { throw new Error("storage offline"); }, terminate });
    await expect(guard.admitSpawn(metadata)).rejects.toThrow("storage offline");
    expect(terminate).toHaveBeenCalledOnce();
  });
});
describe("terminal orphan identity", () => {
  const recorded = new Date(metadata.startedAt);
  it("accepts only a birth shortly before recorded spawn metadata", () => {
    expect(matchesRecordedProcessBirth(recorded, new Date(recorded.getTime() - 100))).toBe(true);
  });
  it("never kills a recycled PID born after the recorded process", () => {
    expect(matchesRecordedProcessBirth(recorded, new Date(recorded.getTime() + 1))).toBe(false);
  });
  it("skips missing, invalid and stale identity", () => {
    expect(matchesRecordedProcessBirth(recorded, null)).toBe(false);
    expect(matchesRecordedProcessBirth(recorded, new Date(NaN))).toBe(false);
    expect(matchesRecordedProcessBirth(recorded, new Date(recorded.getTime() - 2001))).toBe(false);
  });
});
