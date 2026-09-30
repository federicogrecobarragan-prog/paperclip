import { describe, expect, it, vi } from "vitest";
import { createServiceTaskScope } from "../services/service-task-scope.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("service task scope", () => {
  it("waits for a writer even after it has published a terminal status", async () => {
    const scope = createServiceTaskScope();
    const gate = deferred();
    let terminal = false;
    let wrote = false;
    scope.track((async () => {
      terminal = true;
      await gate.promise;
      wrote = true;
    })());
    let drained = false;
    const drain = scope.stopAndDrain().then(() => { drained = true; });
    await Promise.resolve();
    expect(terminal).toBe(true);
    expect(drained).toBe(false);
    gate.resolve();
    await drain;
    expect(wrote).toBe(true);
  });

  it("closes admission before waiting and tracks commands already admitted", async () => {
    const scope = createServiceTaskScope();
    const gate = deferred();
    const write = vi.fn();
    const service = scope.bind({ write: async () => { await gate.promise; write(); } });
    const accepted = service.write();
    let drained = false;
    const drain = scope.stopAndDrain().then(() => { drained = true; });
    expect(() => service.write()).toThrow("Service is stopped");
    await Promise.resolve();
    expect(drained).toBe(false);
    gate.resolve();
    await Promise.all([accepted, drain]);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("waits for dependent background work added during the drain", async () => {
    const scope = createServiceTaskScope();
    const first = deferred();
    const child = deferred();
    scope.track(first.promise.then(() => { scope.track(child.promise); }));
    let drained = false;
    const drain = scope.stopAndDrain().then(() => { drained = true; });
    first.resolve();
    // Let the initial snapshot finish without releasing its dependent writer.
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    expect(drained).toBe(false);
    child.resolve();
    await drain;
  });

  it("settles rejected work without leaking a rejected cleanup promise", async () => {
    const scope = createServiceTaskScope();
    const failure = scope.track(Promise.reject(new Error("writer failed")));
    await expect(failure).rejects.toThrow("writer failed");
    await scope.stopAndDrain();
    await scope.stopAndDrain();
  });

  it("keeps the drain local to one service instance", async () => {
    const first = createServiceTaskScope();
    const second = createServiceTaskScope();
    const gate = deferred();
    first.track(gate.promise);
    await second.stopAndDrain();
    expect(first.isStopped()).toBe(false);
    gate.resolve();
    await first.stopAndDrain();
  });

  it("preserves synchronous return values of service methods", () => {
    const scope = createServiceTaskScope();
    const service = scope.bind({ read: () => 17 });
    expect(service.read()).toBe(17);
  });
});
