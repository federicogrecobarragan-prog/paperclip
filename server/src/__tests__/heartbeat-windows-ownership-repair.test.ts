import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import type { ChildProcess } from "node:child_process";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { runningProcesses } from "../adapters/index.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), sweep: vi.fn() }));
vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js");
  return { ...actual, getServerAdapter: () => ({ supportsLocalAgentJwt:false,execute:mocks.execute }) };
});
vi.mock("@paperclipai/adapter-utils/windows-process-tree", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/windows-process-tree")>("@paperclipai/adapter-utils/windows-process-tree");
  return { ...actual, terminateWindowsOrphanedDescendants: mocks.sweep };
});
const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Embedded Postgres unavailable: ${support.reason}`);
(support.supported && process.platform === "win32" ? describe : describe.skip)("unknown Windows orphan waits for manual repair",()=>{
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async()=>{ temp=await startEmbeddedPostgresTestDatabase("synthetic-windows-repair-");db=createDb(temp.connectionString); },30000);
  afterAll(async()=>{ runningProcesses.clear();await temp?.cleanup(); });
  for (const discoveryFailed of [false,true]) {
    it(discoveryFailed ? "holds execution when identity discovery fails" : "holds execution when an unverified child survives",async()=>{
      const companyId=randomUUID(),agentId=randomUUID(),runId=randomUUID(),issueId=randomUUID(),deferredWakeupId=randomUUID();
      const pid=999_999_999;
      const now=new Date("2026-01-01T00:00:00.000Z");
      await db.insert(companies).values({id:companyId,name:"Synthetic repair",issuePrefix:`S${runId.slice(0,6)}`});
      await db.insert(agents).values({id:agentId,companyId,name:"Synthetic worker",role:"engineer",status:"running",
        adapterType:"codex_local",adapterConfig:{},runtimeConfig:{heartbeat:{wakeOnDemand:true}},permissions:{}});
      await db.insert(heartbeatRuns).values({id:runId,companyId,agentId,status:"running",processPid:pid,
        processStartedAt:now,startedAt:now,updatedAt:now,contextSnapshot:{issueId,paperclipEnvironment:{driver:"local"}}});
      await db.insert(issues).values({id:issueId,companyId,title:"Synthetic repair case",status:"in_progress",
        assigneeAgentId:agentId,checkoutRunId:runId,executionAgentNameKey:"synthetic worker",executionRunId:runId,
        executionLockedAt:now});
      await db.insert(agentWakeupRequests).values({id:deferredWakeupId,companyId,agentId,source:"automation",
        triggerDetail:"system",reason:"issue_execution_deferred",payload:{issueId,_paperclipWakeContext:{issueId}},
        status:"deferred_issue_execution",requestedAt:now});
      const handle={child:{pid} as ChildProcess,graceSec:1,processGroupId:null};
      runningProcesses.set(runId,handle);
      mocks.execute.mockClear();
      mocks.sweep.mockReset();
      if(discoveryFailed)mocks.sweep.mockRejectedValue(new Error("Synthetic snapshot unavailable"));
      else mocks.sweep.mockResolvedValue({terminated:[],skipped:[999_999_998],repairRequired:true,ownership:"root_missing"});
      await heartbeatService(db).reapOrphanedRuns();
      const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,runId));
      const [issue]=await db.select().from(issues).where(eq(issues.id,issueId));
      const [agent]=await db.select().from(agents).where(eq(agents.id,agentId));
      const all=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId,companyId));
      const events=await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId,runId));
      expect(run.status).toBe("failed");
      expect(run.errorCode).toBe("process_ownership_unverified");
      expect(run.resultJson).toMatchObject({manualRepairRequired:true});
      expect(issue.status).toBe("blocked");
      expect(issue.executionRunId).toBe(runId);
      expect(issue.checkoutRunId).toBe(runId);
      expect(agent.status).toBe("paused");
      expect(agent.errorReason).toContain("Manual repair required");
      expect(all).toHaveLength(1);
      expect(mocks.execute).not.toHaveBeenCalled();
      expect(runningProcesses.get(runId)).toBe(handle);
      expect(events.some(event=>event.message?.includes("Manual repair required"))).toBe(true);
      runningProcesses.clear();

      const firstReplay=await heartbeatService(db).reconcileTerminalRuns();
      const secondReplay=await heartbeatService(db).reconcileTerminalRuns();
      const [reconciledRun]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,runId));
      const [reconciledIssue]=await db.select().from(issues).where(eq(issues.id,issueId));
      const [deferredWake]=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,deferredWakeupId));
      const reconciledRuns=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId,companyId));
      expect(firstReplay).toEqual({completed:1,pending:0});
      expect(secondReplay).toEqual({completed:0,pending:0});
      expect(reconciledRun.terminalFinalizedAt).toBeInstanceOf(Date);
      expect(reconciledIssue).toMatchObject({status:"blocked",checkoutRunId:runId,executionRunId:runId,
        executionAgentNameKey:"synthetic worker",executionLockedAt:now});
      expect(deferredWake).toMatchObject({status:"deferred_issue_execution",runId:null});
      expect(reconciledRuns).toHaveLength(1);
      expect(mocks.execute).not.toHaveBeenCalled();
      runningProcesses.delete(runId);
    },20000);
  }

  it("still releases normal terminal claims and promotes deferred work",async()=>{
    const companyId=randomUUID(),agentId=randomUUID(),runId=randomUUID(),issueId=randomUUID(),deferredWakeupId=randomUUID();
    const startedAt=new Date("2026-01-02T00:00:00.000Z");
    const finishedAt=new Date("2026-01-02T00:01:00.000Z");
    await db.insert(companies).values({id:companyId,name:"Synthetic normal finalization",issuePrefix:`N${runId.slice(0,6)}`});
    await db.insert(agents).values({id:agentId,companyId,name:"Synthetic worker",role:"engineer",status:"idle",
      adapterType:"codex_local",adapterConfig:{},runtimeConfig:{heartbeat:{wakeOnDemand:true}},permissions:{}});
    await db.insert(heartbeatRuns).values({id:runId,companyId,agentId,status:"succeeded",startedAt,finishedAt,
      contextSnapshot:{issueId,taskKey:`issue:${issueId}`},terminalFinalizationJson:{version:1,adapterType:null,
        ledger:null,session:null,completed:{}}});
    await db.insert(issues).values({id:issueId,companyId,title:"Synthetic normal case",status:"done",completedAt:finishedAt,
      assigneeAgentId:agentId,checkoutRunId:runId,executionAgentNameKey:"synthetic worker",executionRunId:runId,
      executionLockedAt:startedAt});
    await db.insert(agentWakeupRequests).values({id:deferredWakeupId,companyId,agentId,source:"automation",
      triggerDetail:"system",reason:"issue_execution_deferred",payload:{issueId,_paperclipWakeContext:{issueId,
        taskKey:`issue:${issueId}`,wakeReason:"issue_commented"}},status:"deferred_issue_execution",requestedAt:startedAt});

    mocks.execute.mockClear();
    expect(await heartbeatService(db).reconcileTerminalRuns()).toEqual({completed:1,pending:0});
    const [reconciledRun]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,runId));
    const [reconciledIssue]=await db.select().from(issues).where(eq(issues.id,issueId));
    const [promotedWake]=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,deferredWakeupId));
    const promotedRun=promotedWake.runId
      ? (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,promotedWake.runId)))[0]
      : null;
    expect(reconciledRun.terminalFinalizedAt).toBeInstanceOf(Date);
    expect(reconciledIssue).toMatchObject({checkoutRunId:null,executionRunId:null,executionAgentNameKey:null,
      executionLockedAt:null});
    expect(promotedWake).toMatchObject({reason:"issue_execution_promoted",runId:expect.any(String)});
    expect(promotedRun).toMatchObject({status:"cancelled",errorCode:"issue_terminal_status"});
    expect(mocks.execute).not.toHaveBeenCalled();
  },20000);
});
