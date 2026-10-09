import fs from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
export type SpawnMetadata = { pid: number; processGroupId: number | null; startedAt: string };

/** The database conditional update remains authoritative across service instances. */
export function createRunSpawnGuard(input: {
  cancelled: () => boolean;
  claimActive: () => Promise<boolean>;
  persistActive: (meta: SpawnMetadata) => Promise<boolean>;
  terminate: (meta: SpawnMetadata) => Promise<void>;
}) {
  return {
    prepare: async () => !input.cancelled() && await input.claimActive() && !input.cancelled(),
    admitSpawn: async (meta: SpawnMetadata) => {
      let admitted = false;
      try {
        admitted = !input.cancelled() && await input.persistActive(meta) && !input.cancelled();
        return admitted;
      } finally {
        // Failed persistence is unsafe too: do not leave an untracked child alive.
        if (!admitted) await input.terminate(meta);
      }
    },
  };
}

/** A recycled PID born later than our metadata can never be this child. */
export function matchesRecordedProcessBirth(recorded: Date | null, actual: Date | null) {
  if (!recorded || !actual) return false;
  const delay = recorded.getTime() - actual.getTime();
  return Number.isFinite(delay) && delay >= 0 && delay <= 2_000;
}

export async function readProcessBirth(pid: number): Promise<Date | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFile("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
      ], { windowsHide: true, timeout: 5_000 });
      const date = new Date(stdout.trim());
      return Number.isNaN(date.getTime()) ? null : date;
    }
    if (process.platform === "linux") {
      const [stat, system, ticks] = await Promise.all([
        fs.readFile(`/proc/${pid}/stat`, "utf8"),
        fs.readFile("/proc/stat", "utf8"),
        execFile("getconf", ["CLK_TCK"], { timeout: 5_000 }),
      ]);
      const boot = Number(/^btime (\d+)$/m.exec(system)?.[1]);
      const startedTicks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
      const rate = Number(ticks.stdout.trim());
      if (!(boot > 0 && startedTicks >= 0 && rate > 0)) return null;
      return new Date((boot + startedTicks / rate) * 1_000);
    }
  } catch { /* Missing process or birth metadata: skip rather than kill by PID alone. */ }
  return null;
}
