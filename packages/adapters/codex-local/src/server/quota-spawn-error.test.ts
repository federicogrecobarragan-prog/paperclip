import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const cp = await importOriginal<typeof import("node:child_process")>();
  return {
    ...cp,
    spawn: (...args: Parameters<typeof cp.spawn>) => mockSpawn(...args) as ReturnType<typeof cp.spawn>,
  };
});

import { getQuotaWindows } from "./quota.js";

function createChildThatErrorsOnMicrotask(err: Error): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stream = Object.assign(new EventEmitter(), {
    setEncoding: () => {},
  });
  Object.assign(child, {
    stdout: stream,
    stderr: Object.assign(new EventEmitter(), { setEncoding: () => {} }),
    stdin: { write: vi.fn(), end: vi.fn() },
    kill: vi.fn(),
  });
  queueMicrotask(() => {
    child.emit("error", err);
  });
  return child;
}

function createReadOnlyRpcChild(args: string[]) {
  const child = new EventEmitter() as ChildProcess;
  const stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  const stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  const methods: string[] = [];
  const kill = vi.fn();
  Object.assign(child, {
    stdout, stderr, kill,
    stdin: { write: (line: string) => {
      const request = JSON.parse(line) as { id?: number; method: string };
      methods.push(request.method);
      if (request.id == null) return;
      queueMicrotask(() => {
        if (args.includes("untrusted")) {
          stderr.emit("data", "invalid value 'untrusted' for '--ask-for-approval'\n");
          child.emit("exit", 2);
          return;
        }
        const result = request.method === "account/rateLimits/read"
          ? { rateLimits: { primary: { usedPercent: 17, resetsAt: 1_800_000_000 } } }
          : request.method === "account/read" ? { account: { type: "chatgpt", planType: "test" } } : {};
        stdout.emit("data", JSON.stringify({ id: request.id, result }) + "\n");
      });
    }, end: vi.fn() },
  });
  return { child, methods, kill };
}

describe("CodexRpcClient spawn failures", () => {
  let previousCodexHome: string | undefined;
  let isolatedCodexHome: string | undefined;

  beforeEach(() => {
    mockSpawn.mockReset();
    // After the RPC path fails, getQuotaWindows() calls readCodexToken() which
    // reads $CODEX_HOME/auth.json (default ~/.codex). Point CODEX_HOME at an
    // empty temp directory so we never hit real host auth or the WHAM network.
    previousCodexHome = process.env.CODEX_HOME;
    isolatedCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-codex-spawn-test-"));
    process.env.CODEX_HOME = isolatedCodexHome;
  });

  afterEach(() => {
    if (isolatedCodexHome) {
      try {
        fs.rmSync(isolatedCodexHome, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      isolatedCodexHome = undefined;
    }
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("does not crash the process when codex is missing; getQuotaWindows returns ok: false", async () => {
    const enoent = Object.assign(new Error("spawn codex ENOENT"), {
      code: "ENOENT",
      errno: -2,
      syscall: "spawn codex",
      path: "codex",
    });
    mockSpawn.mockImplementation(() => createChildThatErrorsOnMicrotask(enoent));

    const result = await getQuotaWindows();

    expect(result.ok).toBe(false);
    expect(result.windows).toEqual([]);
    expect(result.error).toContain("Codex app-server");
    expect(result.error).toContain("spawn codex ENOENT");
  });

  it("reads quotas without prompts or model execution using the supported read-only CLI policy", async () => {
    let rpc: ReturnType<typeof createReadOnlyRpcChild>;
    mockSpawn.mockImplementation((_command, args: string[]) => {
      rpc = createReadOnlyRpcChild(args);
      return rpc.child;
    });

    const result = await getQuotaWindows();

    expect(result.ok).toBe(true);
    expect(result.source).toBe("codex-rpc");
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.usedPercent).toBe(17);
    expect(mockSpawn.mock.calls[0]?.slice(0, 2)).toEqual([
      "codex", ["-s", "read-only", "-a", "never", "app-server"],
    ]);
    expect(rpc!.methods).toEqual([
      "initialize", "initialized", "account/rateLimits/read", "account/read",
    ]);
    expect(rpc!.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
