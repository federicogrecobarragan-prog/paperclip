import { beforeEach, expect, it, vi } from "vitest";
import { captureWindowsProcessOwnership, terminateWindowsOrphanedDescendants, terminateWindowsProcessTree } from "./windows-process-tree.js";

const fixture = vi.hoisted(() => ({ rows: [] as unknown[], kills: [] as string[][], alive: new Set<number>(),
  afterKill: null as null | ((pid:number,tree:boolean)=>void) }));
vi.mock("node:child_process", () => {
  const execFile = vi.fn();
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
    value: async (file: string, args: string[]) => {
      if (file.endsWith("powershell.exe")) return { stdout: JSON.stringify(fixture.rows), stderr: "" };
      if (file.endsWith("taskkill.exe")) {
        fixture.kills.push(args);
        fixture.alive.delete(Number(args[1]));
        fixture.afterKill?.(Number(args[1]),args.includes("/T"));
        return { stdout: "", stderr: "" };
      }
      throw new Error("Unexpected synthetic command");
    },
  });
  return { execFile };
});
const rootPid = 999001, childPid = 999002, grandchildPid = 999003;
const recorded = 1_000_000;
const row = (pid: number, parentPid: number, createdAtMs: number | null) => ({ ProcessId: pid,
  ParentProcessId: parentPid, CreatedAtMs: createdAtMs });
beforeEach(() => {
  fixture.rows = [];
  fixture.kills = [];
  fixture.alive = new Set([rootPid,childPid,grandchildPid]);
  fixture.afterKill=null;
});
it.runIf(process.platform==="win32")("survivor fallback refuses a replacement born after the original tree was killed",async()=>{
  fixture.rows=[row(rootPid,1,recorded-10),row(childPid,rootPid,recorded+2)];
  fixture.afterKill=(pid,tree)=>{
    if(pid===rootPid && tree) fixture.rows=[row(childPid,rootPid,recorded+3)];
  };
  const signal=vi.spyOn(process,"kill").mockImplementation(pid=>{
    if(!fixture.alive.has(pid))throw Object.assign(new Error("synthetic dead"),{code:"ESRCH"});
    return true;
  });
  try {
    await expect(terminateWindowsProcessTree(rootPid,{ownerStartedAtMs:recorded})).rejects.toThrow(/birth|identity|ownership/i);
    expect(fixture.kills).toEqual([["/PID",String(rootPid),"/T","/F"]]);
  } finally {signal.mockRestore();}
});
async function sweep(ownershipProof?: Awaited<ReturnType<typeof captureWindowsProcessOwnership>>) {
  const signal = vi.spyOn(process,"kill").mockImplementation((pid) => {
    if (!fixture.alive.has(pid)) throw Object.assign(new Error("synthetic dead"),{code:"ESRCH"});
    return true;
  });
  try { return await terminateWindowsOrphanedDescendants({rootPid,ownerStartedAtMs:recorded,ownershipProof}); }
  finally { signal.mockRestore(); }
}
it.runIf(process.platform === "win32")("preserves a recycled root's newer child and grandchild", async () => {
  fixture.rows=[row(rootPid,1,recorded+1),row(childPid,rootPid,recorded+2),row(grandchildPid,childPid,recorded+3)];
  const result=await sweep();
  expect(fixture.kills).toEqual([]);
  expect(result.terminated).toEqual([]);
  expect(result.skipped).toEqual(expect.arrayContaining([childPid,grandchildPid]));
  expect(result.repairRequired).toBe(true);
  expect(result.ownership).toBe("root_reused");
});
it.runIf(process.platform === "win32")("preserves a newer tree when a recycled root has died again", async () => {
  fixture.rows=[row(childPid,rootPid,recorded+2),row(grandchildPid,childPid,recorded+3)];
  fixture.alive.delete(rootPid);
  const result=await sweep();
  expect(fixture.kills).toEqual([]);
  expect(result.terminated).toEqual([]);
  expect(result.skipped).toEqual(expect.arrayContaining([childPid,grandchildPid]));
  expect(result.repairRequired).toBe(true);
  expect(result.ownership).toBe("root_missing");
});
it.runIf(process.platform === "win32")("preserves descendants when the OS withholds root birth", async () => {
  fixture.rows=[row(rootPid,1,null),row(childPid,rootPid,recorded+2)];
  const result=await sweep();
  expect(fixture.kills).toEqual([]);
  expect(result.skipped).toContain(childPid);
  expect(result.repairRequired).toBe(true);
});
it.runIf(process.platform === "win32")("uses a captured identity proof without killing unknown new descendants via /T",async()=>{
  fixture.rows=[row(rootPid,1,recorded-10),row(childPid,rootPid,recorded+2)];
  const proof=await captureWindowsProcessOwnership({rootPid,ownerStartedAtMs:recorded});
  fixture.rows=[row(childPid,rootPid,recorded+2),row(grandchildPid,childPid,recorded+3)];
  fixture.alive.delete(rootPid);
  const result=await sweep(proof);
  expect(fixture.kills).toEqual([["/PID",String(childPid),"/F"]]);
  expect(result.terminated).toEqual([childPid]);
  expect(result.skipped).toEqual([grandchildPid]);
  expect(result.repairRequired).toBe(true);
});
it.runIf(process.platform === "win32")("rejects an old token when the root PID reappears with a new birth",async()=>{
  fixture.rows=[row(rootPid,1,recorded-10),row(childPid,rootPid,recorded+2)];
  const proof=await captureWindowsProcessOwnership({rootPid,ownerStartedAtMs:recorded});
  fixture.rows=[row(rootPid,1,recorded+1),row(childPid,rootPid,recorded+2)];
  const result=await sweep(proof);
  expect(fixture.kills).toEqual([]);
  expect(result.repairRequired).toBe(true);
});
it.runIf(process.platform === "win32")("does not accept a forged token or a captured PID with a different birth",async()=>{
  fixture.rows=[row(rootPid,1,recorded-10),row(childPid,rootPid,recorded+2)];
  const proof=await captureWindowsProcessOwnership({rootPid,ownerStartedAtMs:recorded});
  fixture.rows=[row(childPid,rootPid,recorded+3)];
  fixture.alive.delete(rootPid);
  expect((await sweep({rootPid,ownerStartedAtMs:recorded})).terminated).toEqual([]);
  expect((await sweep(proof)).terminated).toEqual([]);
  expect(fixture.kills).toEqual([]);
});
it.runIf(process.platform === "win32")("normal termination rejects a live recycled root before taskkill /T",async()=>{
  fixture.rows=[row(rootPid,1,recorded+1),row(childPid,rootPid,recorded+2)];
  const signal=vi.spyOn(process,"kill").mockImplementation(pid=>{
    if(!fixture.alive.has(pid)) throw Object.assign(new Error("synthetic dead"),{code:"ESRCH"});
    return true;
  });
  try {
    const terminate=terminateWindowsProcessTree as (pid:number,identity?:{ownerStartedAtMs:number})=>Promise<boolean>;
    await expect(terminate(rootPid,{ownerStartedAtMs:recorded})).rejects.toThrow(/birth|ownership/i);
    expect(fixture.kills).toEqual([]);
  } finally {signal.mockRestore();}
});
it.runIf(process.platform === "win32")("normal termination refuses a legacy raw PID without identity",async()=>{
  fixture.rows=[row(rootPid,1,recorded-10),row(childPid,rootPid,recorded+2)];
  const signal=vi.spyOn(process,"kill").mockImplementation(pid=>{
    if(!fixture.alive.has(pid)) throw Object.assign(new Error("synthetic dead"),{code:"ESRCH"});
    return true;
  });
  try {
    await expect(terminateWindowsProcessTree(rootPid)).rejects.toThrow(/birth|identity|ownership/i);
    expect(fixture.kills).toEqual([]);
  } finally {signal.mockRestore();}
});
