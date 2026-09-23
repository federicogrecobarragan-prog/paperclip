import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const pendingTerminations = new Map<number, Promise<boolean>>();

interface ProcessRow {
  pid: number;
  parentPid: number;
  /** Epoch ms reported by Windows, or null when the OS withholds it. */
  createdAtMs: number | null;
}

export interface OrphanSweepResult {
  /** Descendants we proved we owned and terminated. */
  terminated: number[];
  /**
   * Descendants reachable through the recorded parent link that we refused to
   * touch because Windows would not give us a creation time to compare against
   * the owning run. Reported, never killed: an unprovable claim is not a claim.
   */
  skipped: number[];
}

function resolveSystemRoot() {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !path.isAbsolute(systemRoot)) {
    throw new Error("Cannot resolve Windows system directory for process-tree termination");
  }
  return systemRoot;
}

async function snapshotProcesses(systemRoot: string): Promise<ProcessRow[]> {
  const { stdout } = await execFileAsync(
    path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate -ErrorAction Stop |" +
        " Select-Object ProcessId,ParentProcessId,@{Name='CreatedAtMs';Expression={" +
        " if ($_.CreationDate) { [long]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null } }})" +
        " | ConvertTo-Json -Compress -Depth 3",
    ],
    { windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
  );
  const rows: unknown = JSON.parse(stdout);
  if (!Array.isArray(rows)) throw new Error("Invalid Windows process-tree snapshot");
  return rows.map((row) => {
    if (!row || typeof row !== "object") throw new Error("Invalid Windows process-tree entry");
    const { ProcessId: pid, ParentProcessId: parentPid, CreatedAtMs: createdAtMs } = row as Record<string, unknown>;
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid)) {
      throw new Error("Invalid Windows process-tree identity");
    }
    return {
      pid: pid as number,
      parentPid: parentPid as number,
      createdAtMs: Number.isSafeInteger(createdAtMs) ? (createdAtMs as number) : null,
    };
  });
}

function indexChildren(rows: ProcessRow[]) {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const siblings = children.get(row.parentPid) ?? [];
    siblings.push(row);
    children.set(row.parentPid, siblings);
  }
  return children;
}

function collectOwnedPids(rows: ProcessRow[], rootPid: number): number[] {
  const children = indexChildren(rows);
  const owned = new Set([rootPid]);
  // `for..of` over a Set observes entries appended during iteration, so this
  // walks the whole subtree without a separate queue.
  for (const pid of owned) {
    for (const child of children.get(pid) ?? []) {
      if (child.pid > 0) owned.add(child.pid);
    }
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

async function forceKill(systemRoot: string, pid: number, tree: boolean) {
  await execFileAsync(
    path.join(systemRoot, "System32", "taskkill.exe"),
    tree ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/F"],
    { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 },
  );
}

/** Kill leftovers one by one; taskkill /T can miss a PID it raced past. */
async function sweepSurvivors(systemRoot: string, pids: number[]) {
  for (const pid of pids) {
    if (pid === process.pid || !isPidAlive(pid)) continue;
    await forceKill(systemRoot, pid, false).catch(() => undefined);
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
    const systemRoot = resolveSystemRoot();
    const ownedPids = collectOwnedPids(await snapshotProcesses(systemRoot), pid);
    try {
      await forceKill(systemRoot, pid, true);
      if (!ownedPids.some(isPidAlive)) return true;
    } catch {
      // Killing a Node child can close its Job Object and let cmd.exe exit
      // before taskkill reaches those PIDs, producing a nonzero result even
      // after complete cleanup. Verify the whole observed tree, not only cmd.
      if (ownedPids.every((ownedPid) => !isPidAlive(ownedPid))) return true;
    }
    // The root is gone but part of the subtree outlived `/T`. Those PIDs came
    // from a snapshot taken while the root was still alive, so ownership is
    // established; finish them individually before reporting success.
    await sweepSurvivors(systemRoot, ownedPids);
    if (ownedPids.some(isPidAlive)) {
      throw new Error(`Failed to terminate Windows process tree for PID ${pid}`);
    }
    return true;
  })().finally(() => pendingTerminations.delete(pid));
  pendingTerminations.set(pid, termination);
  return termination;
}

/**
 * Reap descendants of a wrapper PID that is already dead.
 *
 * Windows keeps a dead process's ParentProcessId on its children, so the link
 * survives the wrapper -- but so does PID reuse, and a recycled wrapper PID
 * would hand us somebody else's subtree. `ownerStartedAtMs` (the run's recorded
 * process start) is the proof we do not control: a descendant is only ours if
 * Windows says it was created at or after the run started. Descendants whose
 * creation time Windows withholds are reported in `skipped`, never killed.
 */
export async function terminateWindowsOrphanedDescendants(input: {
  rootPid: number;
  ownerStartedAtMs: number;
}): Promise<OrphanSweepResult> {
  const { rootPid, ownerStartedAtMs } = input;
  if (process.platform !== "win32") {
    throw new Error("Windows process-tree termination requires Windows");
  }
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0 || rootPid === process.pid) {
    throw new Error("Refusing an invalid or self process-tree target");
  }
  if (!Number.isFinite(ownerStartedAtMs)) {
    // Fail closed: without the owning run's start time we cannot rule out PID
    // reuse, and a wrong kill here takes down an unrelated process.
    throw new Error("Refusing an orphan sweep without the owning run start time");
  }

  const systemRoot = resolveSystemRoot();
  const rows = await snapshotProcesses(systemRoot);
  const children = indexChildren(rows);
  const terminated: number[] = [];
  const skipped: number[] = [];
  const owned = new Set<number>([rootPid]);

  for (const pid of owned) {
    for (const child of children.get(pid) ?? []) {
      if (child.pid <= 0 || owned.has(child.pid) || child.pid === process.pid) continue;
      if (child.createdAtMs === null || child.createdAtMs < ownerStartedAtMs) {
        skipped.push(child.pid);
        continue;
      }
      owned.add(child.pid);
    }
  }
  owned.delete(rootPid);
  if (owned.has(process.pid)) throw new Error("Refusing to terminate the current process ancestor");

  // Snapshot liveness first: killing one branch with `/T` takes its own
  // subtree down too, so report on what we found alive, not on what each
  // individual taskkill call happened to reach.
  const candidates = [...owned].filter(isPidAlive);
  for (const pid of candidates) {
    if (!isPidAlive(pid)) continue;
    await forceKill(systemRoot, pid, true).catch(() => undefined);
    if (isPidAlive(pid)) {
      await forceKill(systemRoot, pid, false).catch(() => undefined);
    }
  }
  for (const pid of candidates) {
    if (isPidAlive(pid)) skipped.push(pid);
    else terminated.push(pid);
  }

  return { terminated, skipped };
}
