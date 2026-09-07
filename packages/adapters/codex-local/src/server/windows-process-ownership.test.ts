import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { runChildProcess, runningProcesses } from "@paperclipai/adapter-utils/server-utils";
import { createCodexOutputInactivityMonitor } from "./output-inactivity-monitor.js";
import { signalCodexChild } from "./execute.js";

it.runIf(process.platform === "win32")("rejects the first monitor fire after original exit while logs still drain", async () => {
  const runId = `windows-late-first-monitor-${Date.now()}`;
  let releaseLog!: () => void;
  const logGate = new Promise<void>((resolve) => { releaseLog = resolve; });
  let sawLog!: () => void;
  const logged = new Promise<void>((resolve) => { sawLog = resolve; });
  let originalChild: ChildProcess | undefined;
  let originalExit: Promise<unknown> | undefined;
  let settled = false;
  const result = runChildProcess(runId, process.execPath,
    ["-e", "process.stdout.write('started\\n');setTimeout(()=>process.exit(0),50)"], {
      cwd: process.cwd(), env: process.env as Record<string, string>, timeoutSec: 0, graceSec: 1,
      onSpawn: async () => {
        originalChild = runningProcesses.get(runId)?.child;
        expect(originalChild).toBeDefined();
        originalExit = once(originalChild!, "exit");
      },
      onLog: async () => { sawLog(); await logGate; },
    }).finally(() => { settled = true; });
  const neighbor = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { windowsHide: true, stdio: "ignore" });
  let monitor: ReturnType<typeof createCodexOutputInactivityMonitor> | undefined;
  let pidDescriptor: PropertyDescriptor | undefined;
  try {
    await logged;
    await originalExit;
    expect(settled).toBe(false);
    expect(runningProcesses.get(runId)?.child).toBe(originalChild);
    // Deterministically model reuse of the old numeric PID by an unrelated live
    // process. Its ChildProcess identity remains the original, already-exited one.
    pidDescriptor = Object.getOwnPropertyDescriptor(originalChild!, "pid");
    Object.defineProperty(originalChild, "pid", { value: neighbor.pid, configurable: true });
    const attempted = new Promise<unknown>((resolve) => {
      monitor = createCodexOutputInactivityMonitor({ timeoutMs: 25, onFire: () => {
        void signalCodexChild({ pid: neighbor.pid!, processGroupId: null, child: originalChild }, "SIGTERM")
          .then(resolve, resolve);
      } });
    });
    await expect(attempted).resolves.toMatchObject({ message: expect.stringContaining("original child is not live") });
    expect(monitor!.state().fired).toBe(true);
    expect(() => process.kill(neighbor.pid!, 0)).not.toThrow();
    expect(settled).toBe(false);
  } finally {
    monitor?.stop();
    if (pidDescriptor) Object.defineProperty(originalChild, "pid", pidDescriptor);
    releaseLog();
    await result;
    if (neighbor.exitCode === null) neighbor.kill();
  }
}, 10_000);
