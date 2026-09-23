import { describe, expect, it } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { signalCodexChild } from "./execute.js";
import {
  CODEX_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS,
  createCodexOutputInactivityMonitor,
  formatOutputInactivityMonitorErrorMessage,
} from "./output-inactivity-monitor.js";

const FAKE_CODEX_SCRIPT = `
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "abc" }) + "\\n");
// Simulate a wedged codex: read stdin forever, never write again.
process.stdin.resume();
process.stdin.on("data", () => {});
setInterval(() => {}, 60_000);
`;

describe("codex inactivity monitor (integration: real subprocess)", () => {
  it(
    "kills a codex child that goes silent after one event and surfaces a monitor failure",
    async () => {
      const runId = `monitor-integration-${Date.now()}`;
      const timeoutMs = 250;
      const logs: Array<{ stream: string; chunk: string }> = [];
      let killTarget: { pid: number | null; processGroupId: number | null } | null = null;
      let monitorFired = false;
      let terminationSignal: NodeJS.Signals | null = null;
      let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
      let elapsedMs = 0;

      // Drive the real production kill path instead of a local copy of it: on
      // Windows that is the process-tree termination, and a copy here would
      // have kept passing while production stranded descendants (LAC-1352).
      let killChain: Promise<void> = Promise.resolve();
      const kill = (signal: NodeJS.Signals) => {
        const target = killTarget;
        if (!target) return;
        killChain = killChain.then(() =>
          signalCodexChild(target, signal).then(
            (sent) => {
              if (sent) terminationSignal = signal;
            },
            () => undefined,
          ),
        );
      };

      const monitor = createCodexOutputInactivityMonitor({
        timeoutMs,
        onFire: (state) => {
          monitorFired = true;
          elapsedMs = (state.firedAt ?? Date.now()) - state.lastEventAt;
          kill("SIGTERM");
          sigkillTimer = setTimeout(() => {
            kill("SIGKILL");
          }, CODEX_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS);
        },
      });

      try {
        const proc = await runChildProcess(runId, process.execPath, ["-e", FAKE_CODEX_SCRIPT], {
          cwd: process.cwd(),
          env: process.env as Record<string, string>,
          timeoutSec: 30,
          graceSec: 1,
          onSpawn: async (meta) => {
            killTarget = { pid: meta.pid, processGroupId: meta.processGroupId };
          },
          onLog: async (stream, chunk) => {
            logs.push({ stream, chunk });
            if (stream === "stdout") {
              monitor.noteStdoutChunk(chunk);
            }
          },
        });

        await killChain;
        expect(monitorFired, "monitor should fire when codex goes silent").toBe(true);
        // Killed by us, not by hitting timeoutSec.
        expect(proc.timedOut).toBe(false);
        if (process.platform === "win32") {
          // Windows terminates by handle, so Node reports no signal even though
          // our kill is exactly what ended the process. Asserting a POSIX signal
          // here is what made this case fail on Windows for its whole life.
          expect(proc.signal).toBeNull();
          expect(proc.exitCode, "a terminated child must not look like a clean exit").not.toBe(0);
        } else {
          expect(["SIGTERM", "SIGKILL"]).toContain(proc.signal);
        }
        expect(["SIGTERM", "SIGKILL"]).toContain(terminationSignal);
        // The errorMessage shape mirrors the AdapterExecutionResult that
        // execute.ts will produce for this case.
        expect(formatOutputInactivityMonitorErrorMessage(elapsedMs)).toMatch(
          /^monitor: no codex output for \d+m \d+s$/,
        );
        // We should have observed exactly one parsed JSONL event before silence.
        expect(monitor.state().parsedEventCount).toBe(1);
      } finally {
        monitor.stop();
        if (sigkillTimer) clearTimeout(sigkillTimer);
      }
    },
    15_000,
  );
});
