import { ChildProcess, execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const pendingTerminations = new WeakMap<ChildProcess, Promise<boolean>>();

function assertOriginalWindowsChild(pid: number, child: ChildProcess) {
  // A live PID (even with two consistent birth snapshots) does not prove it
  // belongs to this run. Node's native process handle refers to the original
  // Windows HANDLE; a zero signal queries that handle, not a reopened PID.
  // Use the native query because ChildProcess.kill(0) also changes .killed.
  const handle = (child as ChildProcess & { _handle?: { kill?: (signal: number) => number } })._handle;
  if (child.pid !== pid || child.exitCode !== null || child.signalCode !== null
    || !handle || typeof handle.kill !== "function" || handle.kill(0) !== 0) {
    throw new Error("Windows process ownership lost: original child is not live; identity-verified operator cleanup required");
  }
}

type ProcessIdentity = { pid: number; parentPid: number; createdAt: bigint };

async function snapshotTree(systemRoot: string, rootPid: number): Promise<ProcessIdentity[]> {
  const { stdout } = await execFileAsync(path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command",
      "@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,@{Name='CreatedTicks';Expression={if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().Ticks.ToString()}}}) | ConvertTo-Json -Compress"],
    { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
  const rows: unknown = JSON.parse(stdout);
  if (!Array.isArray(rows)) throw new Error("Invalid Windows process-tree snapshot");
  const children = new Map<number, ProcessIdentity[]>();
  let root: ProcessIdentity | undefined;
  for (const row of rows) {
    if (!row || typeof row !== "object") throw new Error("Invalid Windows process-tree entry");
    const { ProcessId: pid, ParentProcessId: parentPid, CreatedTicks: createdTicks } = row;
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid)) {
      throw new Error("Invalid Windows process-tree identity");
    }
    // Windows' idle/system entries may not expose a creation time. They are
    // never eligible run descendants; fail closed if one is linked to this tree.
    const createdAt = typeof createdTicks === "string" && /^\d+$/.test(createdTicks)
      ? BigInt(createdTicks) : 0n;
    const entry = { pid, parentPid, createdAt };
    if (pid === rootPid) root = entry;
    const siblings = children.get(parentPid) ?? [];
    siblings.push(entry);
    children.set(parentPid, siblings);
  }
  if (!root || root.createdAt <= 0n) throw new Error("Windows process-tree root identity is unavailable");
  const owned = new Map([[root.pid, root]]);
  for (const parent of owned.values()) {
    for (const child of children.get(parent.pid) ?? []) {
      if (child.pid <= 0) continue;
      // PPID alone can link an older orphan to a recycled parent PID. taskkill
      // walks its own tree, so refusing ambiguity is safer than merely omitting
      // that orphan from our verification snapshot and still using /T.
      if (child.createdAt <= 0n || child.createdAt < parent.createdAt || owned.has(child.pid)) {
        throw new Error("Refusing ambiguous Windows process-tree ownership");
      }
      owned.set(child.pid, child);
    }
  }
  if (owned.has(process.pid)) throw new Error("Refusing to terminate the current process ancestor");
  return [...owned.values()];
}

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Windows signals terminate only the wrapper PID. Kill its tree before the
 * wrapper disappears, while Windows can still resolve descendant ownership.
 * Never fall back to killing only the wrapper: that strands its descendants.
 */
export function terminateWindowsProcessTree(pid: number, child?: ChildProcess): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    return Promise.reject(new Error("Refusing an invalid or self process-tree target"));
  }
  if (process.platform !== "win32") {
    return Promise.reject(new Error("Windows process-tree termination requires Windows"));
  }
  if (!(child instanceof ChildProcess) || child.pid !== pid) {
    return Promise.reject(new Error("Windows process ownership unavailable: original child handle required; identity-verified operator cleanup required"));
  }
  const pending = pendingTerminations.get(child);
  if (pending) return pending;

  const termination = (async () => {
    assertOriginalWindowsChild(pid, child);
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!systemRoot || !path.isAbsolute(systemRoot)) {
      throw new Error("Cannot resolve Windows system directory for process-tree termination");
    }
    const observed = await snapshotTree(systemRoot, pid);
    assertOriginalWindowsChild(pid, child);
    const current = await snapshotTree(systemRoot, pid);
    assertOriginalWindowsChild(pid, child);
    if (current[0]!.createdAt !== observed[0]!.createdAt) {
      throw new Error("Windows process-tree root identity changed before termination");
    }
    const currentByPid = new Map(current.map((entry) => [entry.pid, entry]));
    if (observed.some((entry) => currentByPid.has(entry.pid)
      && currentByPid.get(entry.pid)!.createdAt !== entry.createdAt)) {
      throw new Error("Windows process-tree descendant identity changed before termination");
    }
    const ownedPids = [...new Set([...observed, ...current].map((entry) => entry.pid))];
    try {
      await execFileAsync(path.join(systemRoot, "System32", "taskkill.exe"),
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 });
      if (ownedPids.some(isPidAlive)) {
        throw new Error("Windows process tree is still alive after termination");
      }
      return true;
    } catch {
      // Killing a Node child can close its Job Object and let cmd.exe exit
      // before taskkill reaches those PIDs, producing a nonzero result even
      // after complete cleanup. Verify the whole observed tree, not only cmd.
      if (ownedPids.every((ownedPid) => !isPidAlive(ownedPid))) return true;
      throw new Error(`Failed to terminate Windows process tree for PID ${pid}`);
    }
  })().finally(() => pendingTerminations.delete(child));
  pendingTerminations.set(child, termination);
  return termination;
}
