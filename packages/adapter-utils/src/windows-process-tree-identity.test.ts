import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: execFileMock }),
}));

import { ChildProcess } from "node:child_process";
import { terminateWindowsProcessTree } from "./windows-process-tree.js";

const snapshot = (rootCreated = "100", childCreated = "200") => ({ stdout: JSON.stringify([
  { ProcessId: 12345, ParentProcessId: 1, CreatedTicks: rootCreated },
  { ProcessId: 12346, ParentProcessId: 12345, CreatedTicks: childCreated },
]) });

describe("Windows process tree birth identity", () => {
  let originalChild: ChildProcess;
  let queryHandle: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.stubGlobal("process", Object.defineProperties(Object.create(process), {
      platform: { value: "win32" }, env: { value: { SystemRoot: process.cwd() } },
      kill: { value: vi.fn(() => true) },
    }));
    execFileMock.mockReset();
    originalChild = Object.assign(new ChildProcess(), { pid: 12345 });
    queryHandle = vi.fn(() => 0);
    Object.defineProperty(originalChild, "_handle", { value: { kill: queryHandle } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("refuses an older orphan sharing a recycled PPID without invoking taskkill", async () => {
    execFileMock.mockResolvedValueOnce(snapshot("300", "200"));
    await expect(terminateWindowsProcessTree(12345, originalChild)).rejects.toThrow("ambiguous");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]![0]).toMatch(/powershell\.exe$/);
  });

  it("refuses a recycled root PID between snapshots without invoking taskkill", async () => {
    execFileMock.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot("150"));
    await expect(terminateWindowsProcessTree(12345, originalChild)).rejects.toThrow("root identity changed");
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls.every(([command]) => command.endsWith("powershell.exe"))).toBe(true);
  });

  it("refuses a recycled descendant PID between snapshots", async () => {
    execFileMock.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot("100", "250"));
    await expect(terminateWindowsProcessTree(12345, originalChild)).rejects.toThrow("descendant identity changed");
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when a tree member has no birth identity", async () => {
    execFileMock.mockResolvedValueOnce(snapshot("100", ""));
    await expect(terminateWindowsProcessTree(12345, originalChild)).rejects.toThrow("ambiguous");
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a persisted PID recycled before the first snapshot without querying or killing it", async () => {
    execFileMock.mockResolvedValue(snapshot("900", "950"));
    await expect(terminateWindowsProcessTree(12345)).rejects.toThrow("original child handle required");
    expect(execFileMock).not.toHaveBeenCalled();
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("rejects an expired original native handle even before Node emits its exit event", async () => {
    queryHandle.mockReturnValue(3); // native query says original process is gone
    execFileMock.mockResolvedValue(snapshot("900", "950"));
    await expect(terminateWindowsProcessTree(12345, originalChild)).rejects.toThrow("original child is not live");
    expect(execFileMock).not.toHaveBeenCalled();
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("rechecks the original handle after a snapshot instead of adopting a new process", async () => {
    queryHandle.mockReturnValueOnce(0).mockReturnValue(3);
    execFileMock.mockResolvedValueOnce(snapshot());
    await expect(terminateWindowsProcessTree(12345, originalChild)).rejects.toThrow("original child is not live");
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
