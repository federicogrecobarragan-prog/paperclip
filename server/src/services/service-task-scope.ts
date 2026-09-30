/** Track completion, including work after a task persists a terminal status. */
export function createServiceTaskScope() {
  let closed = false;
  const pending = new Set<Promise<unknown>>();

  function track<T>(promise: Promise<T>): Promise<T> {
    pending.add(promise);
    // Both branches remove the original promise; no rejected cleanup promise escapes.
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  }

  function bind<T extends object>(methods: T): T {
    return Object.fromEntries(Object.entries(methods).map(([name, method]) => [
      name,
      typeof method !== "function" ? method : (...args: unknown[]) => {
        if (closed) throw new Error("Service is stopped");
        const result: unknown = Reflect.apply(method, methods, args);
        if (result instanceof Promise) track(result);
        return result;
      },
    ])) as T;
  }

  async function stopAndDrain() {
    closed = true;
    // An admitted task can add dependent work while this snapshot is settling.
    while (pending.size > 0) await Promise.allSettled([...pending]);
  }

  return { track, bind, stopAndDrain, isStopped: () => closed };
}
