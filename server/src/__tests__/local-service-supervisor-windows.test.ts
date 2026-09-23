import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { terminateLocalService } from "../services/local-service-supervisor.js";

it.runIf(process.platform === "win32")("Board cancellation stops the real wrapper, child and grandchild", async () => {
  const fixture = fileURLToPath(new URL("../../../packages/adapter-utils/src/__fixtures__/windows-process-tree.cmd", import.meta.url));
  const child = spawn(process.env.ComSpec!, ["/d", "/s", "/c", `""${fixture}" "${process.execPath}""`], {
    windowsHide: true, windowsVerbatimArguments: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout!.on("data", (chunk) => { output += String(chunk); });
  const pids = () => [child.pid!, ...Array.from(output.matchAll(/tree-pid:(\d+)/g), (match) => Number(match[1]))];
  const isAlive = (pid: number) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  try {
    const deadline = Date.now() + 8_000;
    while (!output.includes("tree-ready") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(pids()).toHaveLength(3);
    expect(pids().every(isAlive)).toBe(true);
    await terminateLocalService({ pid: child.pid!, processGroupId: null }, { forceAfterMs: 100 });
    expect(pids().every((pid) => !isAlive(pid))).toBe(true);
  } finally {
    // Each PID was emitted by our isolated fixture, never discovered globally.
    for (const pid of [...pids(), child.pid]) {
      if (pid && isAlive(pid)) await terminateLocalService({ pid, processGroupId: null });
    }
  }
}, 15_000);
