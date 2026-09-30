import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runChildProcess, runningProcesses } from "./server-utils.js";
import { captureWindowsProcessOwnership, terminateWindowsOrphanedDescendants, terminateWindowsProcessTree,
  type WindowsProcessOwnershipProof } from "./windows-process-tree.js";

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
    const rootStartedAtMs = Date.now();
    const neighbor = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { windowsHide: true, stdio: "ignore" });
    const neighborStartedAtMs = Date.now();
    let proof: WindowsProcessOwnershipProof | undefined;
    let output = "";
    root.stdout!.on("data", (chunk) => { output += String(chunk); });
    try {
      await waitFor(() => output.includes("tree-ready"));
      const pids = [root.pid!, ...pidsIn(output)];
      expect(pids).toHaveLength(3);
      expect(pids.every(isAlive)).toBe(true);
      proof = await captureWindowsProcessOwnership({ rootPid:root.pid!,ownerStartedAtMs:rootStartedAtMs });
      const first = terminateWindowsProcessTree(root.pid!,{ownerStartedAtMs:rootStartedAtMs});
      expect(terminateWindowsProcessTree(root.pid!,{ownerStartedAtMs:rootStartedAtMs})).toBe(first);
      await first;
      await waitFor(() => pids.every((pid) => !isAlive(pid)));
      expect(isAlive(neighbor.pid!)).toBe(true);
    } finally {
      if (proof) await terminateWindowsOrphanedDescendants({rootPid:proof.rootPid,
        ownerStartedAtMs:proof.ownerStartedAtMs,ownershipProof:proof});
      if(root.pid && isAlive(root.pid)) await terminateWindowsProcessTree(root.pid,{ownerStartedAtMs:rootStartedAtMs});
      if(neighbor.pid && isAlive(neighbor.pid)) await terminateWindowsProcessTree(neighbor.pid,{ownerStartedAtMs:neighborStartedAtMs});
    }
  }, 15_000);

  it.runIf(process.platform === "win32")("timeout waits for the entire tree to exit before releasing run tracking", async () => {
    const runId = `windows-tree-timeout-${Date.now()}`;
    let output = "";
    let proof: WindowsProcessOwnershipProof | undefined;
    try {
      const running = runChildProcess(runId, fixture, [process.execPath], {
        cwd: process.cwd(), env: process.env as Record<string, string>,
        timeoutSec: 5, graceSec: 1,
        onLog: async (_stream, chunk) => { output += chunk; },
      });
      await waitFor(() => Boolean(runningProcesses.get(runId)?.windowsOwnershipProof));
      proof=runningProcesses.get(runId)?.windowsOwnershipProof;
      const result = await running;
      expect(output).toContain("tree-ready");
      expect(pidsIn(output)).toHaveLength(2);
      expect(isAlive(result.pid!)).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(pidsIn(output).every((pid) => !isAlive(pid))).toBe(true);
      expect(runningProcesses.has(runId)).toBe(false);
    } finally {
      if(proof) await terminateWindowsOrphanedDescendants({rootPid:proof.rootPid,
        ownerStartedAtMs:proof.ownerStartedAtMs,ownershipProof:proof});
    }
  }, 15_000);
});
