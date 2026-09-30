import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";
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
      const companyId=randomUUID(),agentId=randomUUID(),runId=randomUUID(),issueId=randomUUID();
      const pid=999_999_999;
      const now=new Date("2026-01-01T00:00:00.000Z");
      await db.insert(companies).values({id:companyId,name:"Synthetic repair",issuePrefix:`S${runId.slice(0,6)}`});
      await db.insert(agents).values({id:agentId,companyId,name:"Synthetic worker",role:"engineer",status:"running",
        adapterType:"codex_local",adapterConfig:{},runtimeConfig:{heartbeat:{wakeOnDemand:true}},permissions:{}});
      await db.insert(heartbeatRuns).values({id:runId,companyId,agentId,status:"running",processPid:pid,
        processStartedAt:now,startedAt:now,updatedAt:now,contextSnapshot:{issueId,paperclipEnvironment:{driver:"local"}}});
      await db.insert(issues).values({id:issueId,companyId,title:"Synthetic repair case",status:"in_progress",
        assigneeAgentId:agentId,executionAgentNameKey:"synthetic worker",executionRunId:runId});
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
      expect(agent.status).toBe("paused");
      expect(agent.errorReason).toContain("Manual repair required");
      expect(all).toHaveLength(1);
      expect(mocks.execute).not.toHaveBeenCalled();
      expect(runningProcesses.get(runId)).toBe(handle);
      expect(events.some(event=>event.message?.includes("Manual repair required"))).toBe(true);
      runningProcesses.delete(runId);
    },20000);
  }
});
