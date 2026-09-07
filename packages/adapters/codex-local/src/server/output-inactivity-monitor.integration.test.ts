import { describe, expect, it } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import {
  CODEX_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS,
  createCodexOutputInactivityMonitor,
  formatOutputInactivityMonitorErrorMessage,
} from "./output-inactivity-monitor.js";
import { resolveCodexHostKillTarget, signalCodexChild } from "./execute.js";

const DESCENDANT_SCRIPT = `
process.stderr.write("descendant:" + process.pid + "\\n");
setTimeout(() => process.exit(0), 30_000);
`;
const CHILD_SCRIPT = `
require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(DESCENDANT_SCRIPT)}], {
  stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
});
${DESCENDANT_SCRIPT}
`;

const FAKE_CODEX_SCRIPT = `
require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(CHILD_SCRIPT)}], {
  stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
});
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "abc" }) + "\\n");
// Simulate a wedged codex: read stdin forever, never write again.
process.stdin.resume();
process.stdin.on("data", () => {});
setTimeout(() => process.exit(0), 30_000);
`;

describe("codex inactivity monitor process ownership", () => {
  it("never maps a sandbox-reported remote pid to a host kill target", () => {
    const remotePidCollidingWithThisHost = process.pid;

    expect(resolveCodexHostKillTarget({
      pid: remotePidCollidingWithThisHost,
      processGroupId: null,
    }, true)).toBeNull();
    expect(resolveCodexHostKillTarget({
      pid: remotePidCollidingWithThisHost,
      processGroupId: null,
    }, false)).toEqual({
      pid: remotePidCollidingWithThisHost,
      processGroupId: null,
    });
  });
});

describe("codex inactivity monitor (integration: real subprocess)", () => {
  it(
    "kills a codex child that goes silent after one event and surfaces a monitor failure",
    async () => {
      const runId = `monitor-integration-${Date.now()}`;
      // Leave enough room for a cold Windows process spawn before asserting
      // the post-event inactivity path. This stays far below the production
      // default while avoiding a pre-first-event race on slower hosts.
      const timeoutMs = 2_000;
      const logs: Array<{ stream: string; chunk: string }> = [];
      let killTarget: { pid: number | null; processGroupId: number | null } | null = null;
      let monitorFired = false;
      let terminationSignal: NodeJS.Signals | null = null;
      let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
      let elapsedMs = 0;
      let termination = Promise.resolve();

      const kill = (signal: NodeJS.Signals) => {
        const target = killTarget;
        if (!target) return;
        termination = signalCodexChild(target, signal).then((sent) => {
          if (sent) terminationSignal = signal;
        });
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
        await termination;

        expect(monitorFired, "monitor should fire when codex goes silent").toBe(true);
        // Process was killed by our signal, not by hitting timeoutSec.
        expect(proc.timedOut).toBe(false);
        if (process.platform === "win32") {
          // Node reports a numeric exit code and a null signal for a process
          // terminated through Windows' emulated signal path.
          expect(proc.exitCode).not.toBe(0);
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
        const descendants = Array.from(logs.map((entry) => entry.chunk).join("").matchAll(/descendant:(\d+)/g),
          (match) => Number(match[1]));
        expect(descendants).toHaveLength(2);
        if (process.platform === "win32") {
          for (const pid of descendants) {
            expect(() => process.kill(pid, 0)).toThrow();
          }
        }
      } finally {
        monitor.stop();
        if (sigkillTimer) clearTimeout(sigkillTimer);
      }
    },
    15_000,
  );
});
