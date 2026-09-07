import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const pendingTerminations = new Map<number, Promise<boolean>>();

async function snapshotTreePids(systemRoot: string, rootPid: number): Promise<number[]> {
  const { stdout } = await execFileAsync(path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command",
      "@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId -ErrorAction Stop | Select-Object ProcessId,ParentProcessId) | ConvertTo-Json -Compress"],
    { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
  const rows: unknown = JSON.parse(stdout);
  if (!Array.isArray(rows)) throw new Error("Invalid Windows process-tree snapshot");
  const children = new Map<number, number[]>();
  for (const row of rows) {
    if (!row || typeof row !== "object") throw new Error("Invalid Windows process-tree entry");
    const { ProcessId: pid, ParentProcessId: parentPid } = row;
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid)) {
      throw new Error("Invalid Windows process-tree identity");
    }
    const siblings = children.get(parentPid) ?? [];
    siblings.push(pid);
    children.set(parentPid, siblings);
  }
  const owned = new Set([rootPid]);
  for (const pid of owned) {
    for (const child of children.get(pid) ?? []) if (child > 0) owned.add(child);
  }
  if (owned.has(process.pid)) throw new Error("Refusing to terminate the current process ancestor");
  return [...owned];
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
export function terminateWindowsProcessTree(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    return Promise.reject(new Error("Refusing an invalid or self process-tree target"));
  }
  if (process.platform !== "win32") {
    return Promise.reject(new Error("Windows process-tree termination requires Windows"));
  }
  const pending = pendingTerminations.get(pid);
  if (pending) return pending;

  const termination = (async () => {
    if (!isPidAlive(pid)) return false;
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!systemRoot || !path.isAbsolute(systemRoot)) {
      throw new Error("Cannot resolve Windows system directory for process-tree termination");
    }
    const ownedPids = await snapshotTreePids(systemRoot, pid);
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
  })().finally(() => pendingTerminations.delete(pid));
  pendingTerminations.set(pid, termination);
  return termination;
}
