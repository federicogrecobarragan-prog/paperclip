import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  captureWindowsProcessOwnership,
  terminateWindowsOrphanedDescendants,
  type WindowsProcessOwnershipProof,
} from "@paperclipai/adapter-utils/windows-process-tree";
import { terminateLocalService } from "../services/local-service-supervisor.js";

it.runIf(process.platform === "win32")("Board cancellation stops the real wrapper, child and grandchild", async () => {
  const fixture = fileURLToPath(new URL("../../../packages/adapter-utils/src/__fixtures__/windows-process-tree.cmd", import.meta.url));
  const spawnRequestedAtMs = Date.now();
  const child = spawn(process.env.ComSpec!, ["/d", "/s", "/c", `""${fixture}" "${process.execPath}""`], {
    windowsHide: true, windowsVerbatimArguments: true, stdio: ["ignore", "pipe", "pipe"],
  });
  // Production records this after spawn returns. The ownership guard expects
  // an observation just after the root birth, not a pre-spawn wall-clock guess.
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let ownershipProof: WindowsProcessOwnershipProof | undefined;
  let output = "";
  let stderr = "";
  let primaryError: unknown;
  let cleanupError: unknown;
  child.stdout!.on("data", (chunk) => { output += String(chunk); });
  child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  const pids = () => [child.pid!, ...Array.from(output.matchAll(/tree-pid:(\d+)/g), (match) => Number(match[1]))];
  const isAlive = (pid: number) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  try {
    const deadline = Date.now() + 8_000;
    while (!output.includes("tree-ready") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(pids()).toHaveLength(3);
    expect(pids().every(isAlive)).toBe(true);
    ownershipProof = await captureWindowsProcessOwnership({ rootPid: child.pid!, ownerStartedAtMs: startedAtMs });
    // Regression: before LAC-1405 the supervisor supplied only the PID. The
    // production guard must fail closed and leave every fixture process alive.
    await expect(
      terminateLocalService({ pid: child.pid!, processGroupId: null }, { forceAfterMs: 100 }),
    ).rejects.toThrow("recorded process birth identity");
    expect(pids().every(isAlive)).toBe(true);
    await terminateLocalService({ pid: child.pid!, processGroupId: null, startedAt }, { forceAfterMs: 100 });
    expect(pids().every((pid) => !isAlive(pid))).toBe(true);
  } catch (error) {
    primaryError = error;
  }

  // Cleanup stays bound to the opaque snapshot captured while the fixture was
  // alive. Never fall back to a PID-only kill: that could target a recycled PID
  // and would also overwrite the primary assertion failure with a second error.
  try {
    if (ownershipProof) {
      const cleanup = await terminateWindowsOrphanedDescendants({
        rootPid: ownershipProof.rootPid,
        ownerStartedAtMs: ownershipProof.ownerStartedAtMs,
        ownershipProof,
      });
      if (cleanup.repairRequired) {
        throw new Error(`Opaque fixture cleanup requires manual repair: ${JSON.stringify(cleanup)}`);
      }
      const deadline = Date.now() + 2_000;
      while (pids().some(isAlive) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (pids().some(isAlive)) {
        throw new Error(`Opaque fixture cleanup left live processes: ${JSON.stringify(pids().filter(isAlive))}`);
      }
    } else if (pids().some(isAlive)) {
      throw new Error("Opaque fixture cleanup is unavailable because ownership capture failed");
    }
  } catch (error) {
    cleanupError = error;
  }

  if (primaryError || cleanupError) {
    const failures = [primaryError, cleanupError].filter((error) => error !== undefined);
    throw new AggregateError(
      failures,
      `Supervisor Windows fixture failed; diagnostics=${JSON.stringify({
        spawnRequestedAtMs,
        startedAtMs,
        rootPid: child.pid ?? null,
        fixturePids: pids(),
        stdout: output,
        stderr,
        primaryError: primaryError instanceof Error ? primaryError.message : primaryError ?? null,
        cleanupError: cleanupError instanceof Error ? cleanupError.message : cleanupError ?? null,
      })}`,
    );
  }
}, 15_000);
