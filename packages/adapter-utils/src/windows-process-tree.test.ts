import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runChildProcess, runningProcesses } from "./server-utils.js";
import { terminateWindowsProcessTree } from "./windows-process-tree.js";

const fixture = fileURLToPath(new URL("./__fixtures__/windows-process-tree.cmd", import.meta.url));
const isAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const pidsIn = (output: string) => Array.from(output.matchAll(/tree-pid:(\d+)/g), (match) => Number(match[1]));

async function waitFor(read: () => boolean, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (!read() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  expect(read()).toBe(true);
}

describe("Windows process tree termination", () => {
  it("refuses invalid and self targets before spawning a termination tool", async () => {
    for (const pid of [0, -1, NaN, 1.5, process.pid]) {
      await expect(terminateWindowsProcessTree(pid)).rejects.toThrow("Refusing");
    }
  });

  it.runIf(process.platform === "win32")("terminates wrapper, child and grandchild while preserving a neighboring process", async () => {
    const root = spawn(process.env.ComSpec!, ["/d", "/s", "/c", `""${fixture}" "${process.execPath}""`], {
      windowsHide: true, windowsVerbatimArguments: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const neighbor = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { windowsHide: true, stdio: "ignore" });
    let output = "";
    root.stdout!.on("data", (chunk) => { output += String(chunk); });
    try {
      await waitFor(() => output.includes("tree-ready"));
      const pids = [root.pid!, ...pidsIn(output)];
      expect(pids).toHaveLength(3);
      expect(pids.every(isAlive)).toBe(true);
      const first = terminateWindowsProcessTree(root.pid!);
      expect(terminateWindowsProcessTree(root.pid!)).toBe(first);
      await first;
      await waitFor(() => pids.every((pid) => !isAlive(pid)));
      expect(isAlive(neighbor.pid!)).toBe(true);
    } finally {
      for (const pid of [...pidsIn(output), root.pid, neighbor.pid]) {
        if (pid && isAlive(pid)) await terminateWindowsProcessTree(pid);
      }
    }
  }, 15_000);

  it.runIf(process.platform === "win32")("timeout waits for the entire tree to exit before releasing run tracking", async () => {
    const runId = `windows-tree-timeout-${Date.now()}`;
    let output = "";
    try {
      const result = await runChildProcess(runId, fixture, [process.execPath], {
        cwd: process.cwd(), env: process.env as Record<string, string>,
        timeoutSec: 3, graceSec: 1,
        onLog: async (_stream, chunk) => { output += chunk; },
      });
      expect(output).toContain("tree-ready");
      expect(pidsIn(output)).toHaveLength(2);
      expect(isAlive(result.pid!)).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(pidsIn(output).every((pid) => !isAlive(pid))).toBe(true);
      expect(runningProcesses.has(runId)).toBe(false);
    } finally {
      for (const pid of pidsIn(output)) if (isAlive(pid)) await terminateWindowsProcessTree(pid);
    }
  }, 15_000);
});
