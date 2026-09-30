import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const pendingTerminations = new Map<string, Promise<boolean>>();

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
  /** Surviving identities require operator repair; no ownership was guessed. */
  repairRequired: boolean;
  ownership: "verified" | "root_missing" | "root_reused" | "root_birth_unknown";
}

export interface WindowsProcessOwnershipProof {
  readonly rootPid: number;
  readonly ownerStartedAtMs: number;
}
const ownershipProofs = new WeakMap<WindowsProcessOwnershipProof, Map<number, ProcessRow>>();

function matchesOwnerBirth(root: ProcessRow | undefined, recorded: number) {
  if (!root || root.createdAtMs === null) return false;
  const delay = recorded - root.createdAtMs;
  return delay >= 0 && delay <= 2_000;
}

function captureOwnedRows(rows: ProcessRow[], root: ProcessRow) {
  const children = indexChildren(rows);
  const owned = new Map<number, ProcessRow>([[root.pid, root]]);
  for (const parent of owned.values()) {
    for (const child of children.get(parent.pid) ?? []) {
      if (child.pid === process.pid) throw new Error("Refusing to claim the current process ancestor");
      if (child.createdAtMs === null || parent.createdAtMs === null || child.createdAtMs < parent.createdAtMs) continue;
      owned.set(child.pid, child);
    }
  }
  return owned;
}

/** Capture identities while the owning root is alive. The token cannot be forged or persisted. */
export async function captureWindowsProcessOwnership(input: {
  rootPid: number;
  ownerStartedAtMs: number;
}): Promise<WindowsProcessOwnershipProof> {
  if (process.platform !== "win32") throw new Error("Windows process ownership requires Windows");
  const { rootPid, ownerStartedAtMs } = input;
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0 || rootPid === process.pid || !Number.isFinite(ownerStartedAtMs)) {
    throw new Error("Refusing an invalid process ownership target");
  }
  const rows = await snapshotProcesses(resolveSystemRoot());
  const root = rows.find(row => row.pid === rootPid);
  if (!matchesOwnerBirth(root, ownerStartedAtMs)) throw new Error("Cannot prove the owning root process birth");
  const proof = Object.freeze({ rootPid, ownerStartedAtMs });
  ownershipProofs.set(proof, captureOwnedRows(rows, root!));
  return proof;
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
async function sweepSurvivors(systemRoot: string, owned: Map<number, ProcessRow>) {
  for (const [pid, expected] of owned) {
    if (pid === process.pid || !isPidAlive(pid)) continue;
    const actual = (await snapshotProcesses(systemRoot)).find(row => row.pid === pid);
    if (!actual && !isPidAlive(pid)) continue;
    if (!actual || actual.createdAtMs !== expected.createdAtMs || actual.parentPid !== expected.parentPid) {
      throw new Error("Windows survivor birth identity changed; manual repair required");
    }
    await forceKill(systemRoot, pid, false).catch(() => undefined);
  }
}

/**
 * Windows signals terminate only the wrapper PID. Kill its tree before the
 * wrapper disappears, while Windows can still resolve descendant ownership.
 * Never fall back to killing only the wrapper: that strands its descendants.
 */
export function terminateWindowsProcessTree(pid: number, identity?: {
  ownerStartedAtMs?: number;
  ownershipProof?: WindowsProcessOwnershipProof;
}): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    return Promise.reject(new Error("Refusing an invalid or self process-tree target"));
  }
  if (process.platform !== "win32") {
    return Promise.reject(new Error("Windows process-tree termination requires Windows"));
  }
  const token = identity?.ownershipProof;
  const validToken = token?.rootPid === pid && ownershipProofs.has(token);
  const ownerStartedAtMs = identity?.ownerStartedAtMs ?? (validToken ? token.ownerStartedAtMs : Number.NaN);
  if (!Number.isFinite(ownerStartedAtMs)) {
    return Promise.reject(new Error("Refusing Windows termination without recorded process birth identity"));
  }
  const key = `${pid}:${ownerStartedAtMs}`;
  const pending = pendingTerminations.get(key);
  if (pending) return pending;

  const termination = (async () => {
    const systemRoot = resolveSystemRoot();
    const rows = await snapshotProcesses(systemRoot);
    const root = rows.find(row => row.pid === pid);
    if (!root || !isPidAlive(pid)) {
      const orphaned = await terminateWindowsOrphanedDescendants({ rootPid: pid, ownerStartedAtMs,
        ownershipProof: validToken ? token : undefined });
      if (orphaned.repairRequired) throw new Error("Windows ownership is unverified; manual repair required");
      return orphaned.terminated.length > 0;
    }
    if (!matchesOwnerBirth(root, ownerStartedAtMs)) {
      throw new Error("Windows root process birth does not match recorded ownership; manual repair required");
    }
    const owned = captureOwnedRows(rows, root);
    const ownedPids = collectOwnedPids(rows, pid);
    if (ownedPids.some(ownedPid => !owned.has(ownedPid))) {
      throw new Error("Windows descendant birth identity is unverified; manual repair required");
    }
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
    await sweepSurvivors(systemRoot, owned);
    if (ownedPids.some(isPidAlive)) {
      throw new Error(`Failed to terminate Windows process tree for PID ${pid}`);
    }
    return true;
  })().finally(() => pendingTerminations.delete(key));
  pendingTerminations.set(key, termination);
  return termination;
}

/**
 * Reap descendants of a wrapper PID that is already dead.
 *
 * Windows keeps a dead process's ParentProcessId on its children, so the link
 * survives the wrapper -- but so does PID reuse, and a recycled wrapper PID
 * would hand us somebody else's subtree. A child's birth after the old run is
 * NOT proof of ownership. A missing root requires an opaque identity snapshot
 * captured while the original root was alive; otherwise report manual repair.
 */
export async function terminateWindowsOrphanedDescendants(input: {
  rootPid: number;
  ownerStartedAtMs: number;
  ownershipProof?: WindowsProcessOwnershipProof;
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
  const terminated: number[] = [];
  const reachable = collectOwnedPids(rows, rootPid).filter(pid => pid !== rootPid && isPidAlive(pid));
  const root = rows.find(row => row.pid === rootPid);
  let ownership: OrphanSweepResult["ownership"] = root
    ? root.createdAtMs === null ? "root_birth_unknown" : matchesOwnerBirth(root, ownerStartedAtMs) ? "verified" : "root_reused"
    : "root_missing";
  const token = input.ownershipProof;
  const remembered = token && token.rootPid === rootPid && token.ownerStartedAtMs === ownerStartedAtMs
    ? ownershipProofs.get(token) : undefined;
  // Even a valid old token cannot authorize a new tree behind a recycled root.
  const proven = ownership === "verified" ? captureOwnedRows(rows, root!)
    : ownership === "root_missing" ? remembered : undefined;
  if (proven && ownership === "root_missing") ownership = "verified";
  const candidates: number[] = [];
  const skipped: number[] = [];
  for (const pid of reachable) {
    const actual = rows.find(row => row.pid === pid), expected = proven?.get(pid);
    if (!expected || expected.createdAtMs === null || actual?.createdAtMs !== expected.createdAtMs || actual.parentPid !== expected.parentPid) {
      skipped.push(pid);
    } else candidates.push(pid);
  }
  // Per-PID cleanup only. /T would kill descendants never present in the proof.
  for (const pid of candidates) {
    if (!isPidAlive(pid)) continue;
    const expected = proven!.get(pid)!;
    const fresh = (await snapshotProcesses(systemRoot)).find(row => row.pid === pid);
    if (!fresh && !isPidAlive(pid)) continue;
    if (!fresh || fresh.createdAtMs !== expected.createdAtMs || fresh.parentPid !== expected.parentPid) {
      skipped.push(pid);
      continue;
    }
    await forceKill(systemRoot, pid, false).catch(() => undefined);
  }
  for (const pid of candidates) {
    if (skipped.includes(pid)) continue;
    if (isPidAlive(pid)) skipped.push(pid);
    else terminated.push(pid);
  }

  return { terminated, skipped, repairRequired: skipped.length > 0, ownership };
}
