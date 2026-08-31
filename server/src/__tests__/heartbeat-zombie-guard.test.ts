import { describe, expect, it } from "vitest";
import {
  heartbeatRunTracksHostLocalChildProcess,
  isZombieRun,
  filterZombieCoalesceTarget,
  isTrackedDeadLocalProcess,
  sanitizeHeartbeatFailureMessage,
} from "../services/heartbeat.ts";

describe("heartbeat process namespace classification", () => {
  it("only treats explicitly local sessioned adapters as host-local children", () => {
    expect(heartbeatRunTracksHostLocalChildProcess({
      adapterType: "codex_local",
      contextSnapshot: { paperclipEnvironment: { driver: "local" } },
    })).toBe(true);

    for (const driver of ["sandbox", "ssh", "plugin", "unknown"]) {
      expect(heartbeatRunTracksHostLocalChildProcess({
        adapterType: "codex_local",
        contextSnapshot: { paperclipEnvironment: { driver } },
      })).toBe(false);
    }
    expect(heartbeatRunTracksHostLocalChildProcess({
      adapterType: "codex_local",
      contextSnapshot: {},
    })).toBe(false);
    expect(heartbeatRunTracksHostLocalChildProcess({
      adapterType: "http",
      contextSnapshot: { paperclipEnvironment: { driver: "local" } },
    })).toBe(false);
  });
});

describe("sanitizeHeartbeatFailureMessage", () => {
  it("does not persist or log details from an untrusted thrown adapter value", () => {
    const secret = "opaque-hostile-adapter-canary";
    const result = sanitizeHeartbeatFailureMessage(
      new Error(`${secret}\u0000tail`),
      { enabled: false },
      "Adapter execution failed",
    );

    expect(result).toBe("Adapter execution failed");
    expect(result).not.toContain(secret);
    expect(result).not.toContain("\u0000");
  });
});

describe("isTrackedDeadLocalProcess", () => {
  it("only bypasses reaper liveness gates for a tracked local run with a valid dead pid", () => {
    expect(isTrackedDeadLocalProcess({
      trackedInMemory: true,
      tracksLocalChild: true,
      processPid: 12345,
      processPidAlive: false,
    })).toBe(true);

    expect(isTrackedDeadLocalProcess({
      trackedInMemory: true,
      tracksLocalChild: true,
      processPid: 12345,
      processPidAlive: true,
    })).toBe(false);
    expect(isTrackedDeadLocalProcess({
      trackedInMemory: false,
      tracksLocalChild: true,
      processPid: 12345,
      processPidAlive: false,
    })).toBe(false);
    expect(isTrackedDeadLocalProcess({
      trackedInMemory: true,
      tracksLocalChild: false,
      processPid: 12345,
      processPidAlive: false,
    })).toBe(false);
    expect(isTrackedDeadLocalProcess({
      trackedInMemory: true,
      tracksLocalChild: true,
      processPid: null,
      processPidAlive: false,
    })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isZombieRun — the core predicate
// ---------------------------------------------------------------------------
describe("isZombieRun", () => {
  it("returns true for a running run not tracked in runningProcesses", () => {
    const run = { status: "running", id: "run-1" };
    const tracked = new Map<string, unknown>();

    expect(isZombieRun(run, tracked)).toBe(true);
  });

  it("returns false for a queued run not tracked in runningProcesses", () => {
    const run = { status: "queued", id: "run-2" };
    const tracked = new Map<string, unknown>();

    expect(isZombieRun(run, tracked)).toBe(false);
  });

  it("returns false for a running run that IS tracked in runningProcesses", () => {
    const run = { status: "running", id: "run-3" };
    const tracked = new Map<string, unknown>([["run-3", { pid: 12345 }]]);

    expect(isZombieRun(run, tracked)).toBe(false);
  });

  it("returns false for a failed run not tracked in runningProcesses", () => {
    const run = { status: "failed", id: "run-4" };
    const tracked = new Map<string, unknown>();

    expect(isZombieRun(run, tracked)).toBe(false);
  });

  it("returns false for a completed run not tracked in runningProcesses", () => {
    const run = { status: "completed", id: "run-5" };
    const tracked = new Map<string, unknown>();

    expect(isZombieRun(run, tracked)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filterZombieCoalesceTarget — the coalescing guard used in both paths
//
// These tests exercise the BEHAVIOR described in spec AC2 and AC3:
// "Coalescing does not refresh updatedAt on zombie runs"
// When the target is a zombie, the filter returns null so the wakeup
// falls through to create a new queued run instead of merging into the dead one.
// ---------------------------------------------------------------------------
describe("filterZombieCoalesceTarget", () => {
  // Bug 1 scenario: a "running" run with no live process is a zombie.
  // Coalescing into it would refresh updatedAt, making it immortal.
  it("returns null for a zombie running run (the critical bug fix)", () => {
    const zombieRun = { status: "running", id: "zombie-1" };
    const emptyTracked = new Map<string, unknown>();

    expect(filterZombieCoalesceTarget(zombieRun, emptyTracked)).toBeNull();
  });

  // Legitimate running process — coalescing should proceed normally.
  it("passes through a legitimate running run that IS tracked", () => {
    const liveRun = { status: "running", id: "live-1" };
    const tracked = new Map<string, unknown>([["live-1", { pid: 99 }]]);

    expect(filterZombieCoalesceTarget(liveRun, tracked)).toBe(liveRun);
  });

  // Queued runs don't have processes yet — they must always pass through.
  // isZombieRun only flags "running" status, so queued runs are safe.
  it("passes through a queued run not tracked (queued runs are not zombies)", () => {
    const queuedRun = { status: "queued", id: "queued-1" };
    const emptyTracked = new Map<string, unknown>();

    expect(filterZombieCoalesceTarget(queuedRun, emptyTracked)).toBe(queuedRun);
  });

  // null target means no candidate to coalesce into — pass through.
  it("passes through null target unchanged", () => {
    const tracked = new Map<string, unknown>();

    expect(filterZombieCoalesceTarget(null, tracked)).toBeNull();
  });

  // Terminal states should never appear as coalesce targets, but if they do,
  // they should pass through (they're not zombies — they're done).
  it("passes through a failed run (terminal state, not a zombie)", () => {
    const failedRun = { status: "failed", id: "failed-1" };
    const emptyTracked = new Map<string, unknown>();

    expect(filterZombieCoalesceTarget(failedRun, emptyTracked)).toBe(failedRun);
  });

  it("passes through a completed run (terminal state, not a zombie)", () => {
    const completedRun = { status: "completed", id: "done-1" };
    const emptyTracked = new Map<string, unknown>();

    expect(filterZombieCoalesceTarget(completedRun, emptyTracked)).toBe(completedRun);
  });

  // Regression guard: after server restart, runningProcesses is empty.
  // Multiple zombie runs should all be filtered to null.
  it("filters multiple zombie runs independently (post-restart scenario)", () => {
    const emptyTracked = new Map<string, unknown>();
    const zombie1 = { status: "running", id: "z1" };
    const zombie2 = { status: "running", id: "z2" };

    expect(filterZombieCoalesceTarget(zombie1, emptyTracked)).toBeNull();
    expect(filterZombieCoalesceTarget(zombie2, emptyTracked)).toBeNull();
  });

  // Mixed scenario: one zombie, one live. Only the zombie is filtered.
  it("correctly distinguishes zombie from live when multiple runs exist", () => {
    const tracked = new Map<string, unknown>([["live-1", { pid: 42 }]]);
    const zombie = { status: "running", id: "zombie-1" };
    const live = { status: "running", id: "live-1" };

    expect(filterZombieCoalesceTarget(zombie, tracked)).toBeNull();
    expect(filterZombieCoalesceTarget(live, tracked)).toBe(live);
  });
});
