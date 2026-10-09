import { expect, it, vi } from "vitest";
import { runChildProcess, runningProcesses } from "./server-utils.js";

vi.mock("./windows-process-tree.js",async()=>{
  const actual=await vi.importActual<typeof import("./windows-process-tree.js")>("./windows-process-tree.js");
  return {...actual,terminateWindowsProcessTree:vi.fn(async()=>{
    throw new Error("Synthetic root birth mismatch; manual repair required");
  })};
});
it.runIf(process.platform==="win32")("a failed verified termination cannot turn child exit zero into success or release tracking",async()=>{
  const runId="synthetic-ownership-failure";
  try {
    await expect(runChildProcess(runId,process.execPath,["-e","console.log('synthetic-ready');setTimeout(()=>process.exit(0),1400)"],{
      cwd:process.cwd(),env:process.env as Record<string,string>,timeoutSec:1,graceSec:1,onLog:async()=>{},
    })).rejects.toMatchObject({code:"process_ownership_unverified"});
    const tracked=runningProcesses.get(runId);
    expect(tracked?.manualRepairRequired).toBe(true);
    expect(tracked?.terminationError).toContain("birth mismatch");
    expect(tracked?.child.exitCode).toBe(0);
  } finally {runningProcesses.delete(runId);}
},5000);
