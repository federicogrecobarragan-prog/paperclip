import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { terminateWindowsOrphanedDescendants } from "./windows-process-tree.js";

const fixture = fileURLToPath(new URL("./__fixtures__/windows-process-tree.cmd", import.meta.url));
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pidsIn = (output: string) => Array.from(output.matchAll(/tree-pid:(\d+)/g), (match) => Number(match[1]));

async function waitFor(read: () => boolean, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (!read() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  return read();
}

describe("Windows orphaned descendant sweep", () => {
  it("refuses a sweep it cannot prove it owns", async () => {
    // Without the owning run's start time we cannot rule out PID reuse, so the
    // dangerous branch must fail closed rather than guess.
    await expect(
      terminateWindowsOrphanedDescendants({ rootPid: 4242, ownerStartedAtMs: Number.NaN }),
    ).rejects.toThrow("Refusing an orphan sweep without the owning run start time");
    for (const rootPid of [0, -1, 1.5, process.pid]) {
      await expect(
        terminateWindowsOrphanedDescendants({ rootPid, ownerStartedAtMs: Date.now() }),
      ).rejects.toThrow("Refusing");
    }
  });

  it.runIf(process.platform === "win32")(
    "reaps descendants left behind by a wrapper that is already dead",
    async () => {
      // Reproduces LAC-1352 exactly: kill only the wrapper PID, the way
      // Windows `process.kill` did, then sweep what it stranded.
      const startedAtMs = Date.now() - 1_000;
      const root = spawn(process.env.ComSpec!, ["/d", "/s", "/c", `""${fixture}" "${process.execPath}""`], {
        windowsHide: true,
        windowsVerbatimArguments: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      root.stdout!.on("data", (chunk) => {
        output += String(chunk);
      });
      const rootPid = root.pid!;
      try {
        expect(await waitFor(() => output.includes("tree-ready"))).toBe(true);
        const descendants = pidsIn(output);
        expect(descendants).toHaveLength(2);
        expect(descendants.every(isAlive)).toBe(true);

        process.kill(rootPid);
        expect(await waitFor(() => !isAlive(rootPid))).toBe(true);
        // The bug: the wrapper is gone and its descendants outlived it.
        expect(descendants.every(isAlive)).toBe(true);

        const result = await terminateWindowsOrphanedDescendants({ rootPid, ownerStartedAtMs: startedAtMs });
        // Every stranded descendant is gone and accounted for. The sweep can
        // also collect the wrapper's conhost, so this is a superset check.
        expect(descendants.every((pid) => !isAlive(pid))).toBe(true);
        expect(descendants.every((pid) => result.terminated.includes(pid))).toBe(true);
        expect(result.skipped).toEqual([]);
      } finally {
        for (const pid of [...pidsIn(output), rootPid]) {
          if (pid && isAlive(pid)) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // Already gone.
            }
          }
        }
      }
    },
    20_000,
  );

  it.runIf(process.platform === "win32")(
    "refuses descendants older than the owning run instead of killing them",
    async () => {
      // A recycled wrapper PID would hand us somebody else's subtree. Anything
      // created before the run started is not ours, so it must be reported and
      // left alone.
      const root = spawn(process.env.ComSpec!, ["/d", "/s", "/c", `""${fixture}" "${process.execPath}""`], {
        windowsHide: true,
        windowsVerbatimArguments: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      root.stdout!.on("data", (chunk) => {
        output += String(chunk);
      });
      const rootPid = root.pid!;
      try {
        expect(await waitFor(() => output.includes("tree-ready"))).toBe(true);
        const descendants = pidsIn(output);
        process.kill(rootPid);
        expect(await waitFor(() => !isAlive(rootPid))).toBe(true);

        const result = await terminateWindowsOrphanedDescendants({
          rootPid,
          // One hour in the future: nothing alive can belong to this run.
          ownerStartedAtMs: Date.now() + 3_600_000,
        });
        expect(result.terminated).toEqual([]);
        expect(descendants.every(isAlive)).toBe(true);
      } finally {
        for (const pid of [...pidsIn(output), rootPid]) {
          if (pid && isAlive(pid)) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // Already gone.
            }
          }
        }
      }
    },
    20_000,
  );
});
