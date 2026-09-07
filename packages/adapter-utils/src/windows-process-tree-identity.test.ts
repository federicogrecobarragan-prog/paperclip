import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: execFileMock }),
}));

import { terminateWindowsProcessTree } from "./windows-process-tree.js";

const snapshot = (rootCreated = "100", childCreated = "200") => ({ stdout: JSON.stringify([
  { ProcessId: 12345, ParentProcessId: 1, CreatedTicks: rootCreated },
  { ProcessId: 12346, ParentProcessId: 12345, CreatedTicks: childCreated },
]) });

describe("Windows process tree birth identity", () => {
  beforeEach(() => {
    vi.stubGlobal("process", Object.defineProperties(Object.create(process), {
      platform: { value: "win32" }, env: { value: { SystemRoot: process.cwd() } },
      kill: { value: vi.fn(() => true) },
    }));
    execFileMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("refuses an older orphan sharing a recycled PPID without invoking taskkill", async () => {
    execFileMock.mockResolvedValueOnce(snapshot("300", "200"));
    await expect(terminateWindowsProcessTree(12345)).rejects.toThrow("ambiguous");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]![0]).toMatch(/powershell\.exe$/);
  });

  it("refuses a recycled root PID between snapshots without invoking taskkill", async () => {
    execFileMock.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot("150"));
    await expect(terminateWindowsProcessTree(12345)).rejects.toThrow("root identity changed");
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls.every(([command]) => command.endsWith("powershell.exe"))).toBe(true);
  });

  it("refuses a recycled descendant PID between snapshots", async () => {
    execFileMock.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot("100", "250"));
    await expect(terminateWindowsProcessTree(12345)).rejects.toThrow("descendant identity changed");
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when a tree member has no birth identity", async () => {
    execFileMock.mockResolvedValueOnce(snapshot("100", ""));
    await expect(terminateWindowsProcessTree(12345)).rejects.toThrow("ambiguous");
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
