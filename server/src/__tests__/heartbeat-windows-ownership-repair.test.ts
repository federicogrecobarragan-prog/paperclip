import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  activityLog,
  agentApiKeys,
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
import { issueService } from "../services/issues.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";
import { runningProcesses } from "../adapters/index.js";
import { actorMiddleware } from "../middleware/auth.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { hasManualOwnershipRepairHold } from "../services/manual-ownership-repair-hold.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), sweep: vi.fn() }));
function recordReleaseHoldObservation(observation: Record<string, unknown>) {
  const evidenceDir = process.env.RELEASE_HOLD_EVIDENCE_DIR;
  if (!evidenceDir) return;
  fs.appendFileSync(path.join(evidenceDir,"observations.jsonl"),`${JSON.stringify(observation)}\n`);
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function interceptHoldRead(database: any, onRead: (rows: any[]) => Promise<void>): any {
  return new Proxy(database, {
    get(target, property) {
      if (property === "transaction") {
        return (callback: any, ...rest: any[]) =>
          target.transaction((tx: any) => callback(interceptHoldRead(tx, onRead)), ...rest);
      }
      if (property === "select") {
        return (fields: any) => {
          const original = target.select(fields);
          const isHoldRead = fields && Object.keys(fields).sort().join(",") === "errorCode,id,resultJson";
          if (!isHoldRead) return original;
          const wrap = (query: any): any => new Proxy(query, {
            get(queryTarget, key) {
              if (key === "then") {
                return (fulfilled: any, rejected: any) =>
                  Promise.resolve(queryTarget)
                    .then(async (rows) => {
                      await onRead(rows as any[]);
                      return rows;
                    })
                    .then(fulfilled, rejected);
              }
              const value = queryTarget[key];
              return typeof value === "function"
                ? (...args: any[]) => wrap(value.apply(queryTarget, args))
                : value;
            },
          });
          return wrap(original);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
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
(support.supported ? describe : describe.skip)("unknown Windows orphan waits for manual repair",()=>{
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let otherDb: ReturnType<typeof createDb>;
  beforeAll(async()=>{ temp=await startEmbeddedPostgresTestDatabase("synthetic-windows-repair-");db=createDb(temp.connectionString);otherDb=createDb(temp.connectionString); },30000);
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
      await heartbeatService(db,{hostPlatform:"win32"}).reapOrphanedRuns();
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

      const mentionAgentId=randomUUID();
      await db.insert(agents).values({id:mentionAgentId,companyId,name:"Synthetic mention target",role:"reviewer",status:"idle",
        adapterType:"codex_local",adapterConfig:{},runtimeConfig:{heartbeat:{wakeOnDemand:true}},permissions:{}});
      const holdWake=await heartbeatService(db).wakeup(mentionAgentId,{
        source:"automation",
        triggerDetail:"system",
        reason:"issue_comment_mentioned",
        payload:{issueId},
        contextSnapshot:{issueId,source:"comment.mention",wakeReason:"issue_comment_mentioned"},
        requestedByActorType:"system",
        requestedByActorId:"system",
      });
      expect(holdWake).toBeNull();
      const [heldAfterWake]=await db.select().from(issues).where(eq(issues.id,issueId));
      expect(heldAfterWake).toMatchObject({checkoutRunId:runId,executionRunId:runId});
      const mentionRuns=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,mentionAgentId));
      expect(mentionRuns).toHaveLength(0);

      const heldConflict = {
        status: 409,
        details: { reason: "manual_ownership_repair_pending" },
      };
      const issuesSvc = issueService(db);
      await expect(issuesSvc.clearExecutionRunIfTerminal(issueId)).rejects.toMatchObject(heldConflict);
      await expect(issuesSvc.clearCheckoutRunIfTerminal(issueId)).rejects.toMatchObject(heldConflict);
      await expect(issuesSvc.update(issueId, { status: "todo" })).rejects.toMatchObject(heldConflict);
      expect(await heartbeatService(db).sweepStaleIssueLocks()).toEqual({cleared:0,issueIds:[]});

      const treeControl = issueTreeControlService(db);
      const {hold} = await treeControl.createHold(companyId,issueId,{
        mode:"cancel",
        reason:"Synthetic ordinary claim-clearing bypass probe",
        actor:{actorType:"user",actorId:"local-board",userId:"local-board"},
      });
      await expect(
        treeControl.cancelIssueStatusesForHold(companyId,issueId,hold.id),
      ).rejects.toMatchObject(heldConflict);

      const token=randomUUID()+randomUUID();
      await db.insert(agentApiKeys).values({
        agentId,
        companyId,
        name:"Synthetic ownership repair route probe",
        keyHash:createHash("sha256").update(token).digest("hex"),
      });
      const agentApp=express();
      agentApp.use(express.json());
      agentApp.use(actorMiddleware(db,{deploymentMode:"authenticated"}));
      agentApp.use(boardMutationGuard());
      agentApp.use("/api",issueRoutes(db,{} as any));
      agentApp.use(errorHandler);

      const agentAdminResponse=await request(agentApp)
        .post(`/api/issues/${issueId}/admin/force-release`)
        .set("authorization",`Bearer ${token}`)
        .set("x-paperclip-run-id",runId);
      expect(agentAdminResponse.status).toBe(403);

      const ordinaryReleaseResponse=await request(agentApp)
        .post(`/api/issues/${issueId}/release`)
        .set("authorization",`Bearer ${token}`)
        .set("x-paperclip-run-id",runId);
      expect(ordinaryReleaseResponse.status).toBe(409);
      expect(ordinaryReleaseResponse.body).toMatchObject({
        error:"Issue claims are held pending audited manual ownership repair",
        details:{reason:"manual_ownership_repair_pending",requiredAction:"board_admin_force_release"},
      });
      const [heldAfterOrdinaryRoutes]=await db.select().from(issues).where(eq(issues.id,issueId));
      expect(heldAfterOrdinaryRoutes).toMatchObject({
        status:"blocked",
        assigneeAgentId:agentId,
        checkoutRunId:runId,
        executionRunId:runId,
        executionAgentNameKey:"synthetic worker",
        executionLockedAt:now,
      });

      const boardApp=express();
      boardApp.use(express.json());
      boardApp.use(actorMiddleware(db,{deploymentMode:"local_trusted"}));
      boardApp.use(boardMutationGuard());
      boardApp.use("/api",issueRoutes(db,{} as any));
      boardApp.use(errorHandler);
      const boardReleaseResponse=await request(boardApp)
        .post(`/api/issues/${issueId}/admin/force-release`);
      expect(boardReleaseResponse.status).toBe(200);

      const [adminReleasedIssue]=await db.select().from(issues).where(eq(issues.id,issueId));
      expect(adminReleasedIssue).toMatchObject({
        status:"blocked",
        assigneeAgentId:agentId,
        checkoutRunId:null,
        executionRunId:null,
        executionAgentNameKey:null,
        executionLockedAt:null,
      });
      const adminAudit=await db.select().from(activityLog).where(eq(activityLog.entityId,issueId));
      expect(adminAudit).toContainEqual(expect.objectContaining({
        actorType:"user",
        actorId:"local-board",
        action:"issue.admin_force_release",
        details:expect.objectContaining({
          issueId,
          actorUserId:"local-board",
          prevCheckoutRunId:runId,
          prevExecutionRunId:runId,
        }),
      }));
      recordReleaseHoldObservation({
        case:discoveryFailed?"identity_discovery_failed":"unverified_child_survives",
        wakeReturnedRun:holdWake?.id??null,
        claimsAfterWake:{checkoutRunId:heldAfterWake.checkoutRunId,executionRunId:heldAfterWake.executionRunId},
        mentionRunCount:mentionRuns.length,
        agentAdminHttpStatus:agentAdminResponse.status,
        ordinaryHttpStatus:ordinaryReleaseResponse.status,
        claimsAfterOrdinary:{checkoutRunId:heldAfterOrdinaryRoutes.checkoutRunId,
          executionRunId:heldAfterOrdinaryRoutes.executionRunId,status:heldAfterOrdinaryRoutes.status},
        manualRepairRequired:reconciledRun.resultJson?.manualRepairRequired,
        errorCode:reconciledRun.errorCode,
        boardAdminHttpStatus:boardReleaseResponse.status,
        claimsAfterBoardAdmin:{checkoutRunId:adminReleasedIssue.checkoutRunId,
          executionRunId:adminReleasedIssue.executionRunId,status:adminReleasedIssue.status},
        boardAuditCount:adminAudit.filter((entry)=>entry.action==="issue.admin_force_release").length,
      });
      runningProcesses.delete(runId);
    },20000);
  }

  const treeActor = { actorType:"user" as const, actorId:"local-board", userId:"local-board" };

  async function seedConcurrentHoldRace(label:string) {
    const companyId=randomUUID(),agentId=randomUUID(),runId=randomUUID(),issueId=randomUUID(),wakeId=randomUUID();
    const now=new Date("2026-01-03T00:00:00.000Z"),pid=999_999_999;
    await db.insert(companies).values({id:companyId,name:`Synthetic ${label}`,issuePrefix:`C${runId.slice(0,6)}`});
    await db.insert(agents).values({id:agentId,companyId,name:"Synthetic race worker",role:"engineer",status:"running",
      adapterType:"codex_local",adapterConfig:{},runtimeConfig:{heartbeat:{wakeOnDemand:true}},permissions:{}});
    await db.insert(heartbeatRuns).values({id:runId,companyId,agentId,status:"running",processPid:pid,
      processStartedAt:now,startedAt:now,updatedAt:now,contextSnapshot:{issueId,paperclipEnvironment:{driver:"local"}}});
    await db.insert(issues).values({id:issueId,companyId,title:`Synthetic ${label}`,status:"in_progress",
      assigneeAgentId:agentId,checkoutRunId:runId,executionRunId:runId,executionAgentNameKey:"synthetic race worker",
      executionLockedAt:now});
    await db.insert(agentWakeupRequests).values({id:wakeId,companyId,agentId,source:"automation",triggerDetail:"system",
      reason:"issue_execution_deferred",payload:{issueId,_paperclipWakeContext:{issueId}},
      status:"deferred_issue_execution",requestedAt:now});
    const token=randomUUID()+randomUUID();
    await db.insert(agentApiKeys).values({agentId,companyId,name:"Synthetic hold race",
      keyHash:createHash("sha256").update(token).digest("hex")});
    runningProcesses.set(runId,{child:{pid} as ChildProcess,graceSec:1,processGroupId:null});
    mocks.execute.mockClear();
    mocks.sweep.mockReset();
    mocks.sweep.mockResolvedValue({terminated:[],skipped:[999_999_998],repairRequired:true,ownership:"root_missing"});
    return {companyId,agentId,runId,issueId,wakeId,token};
  }

  function issueApp(database:any) {
    const app=express();
    app.use(express.json());
    app.use(actorMiddleware(database,{deploymentMode:"authenticated"}));
    app.use(boardMutationGuard());
    app.use("/api",issueRoutes(database,{} as any));
    app.use(errorHandler);
    return app;
  }

  async function waitForHoldMarker(runId:string) {
    const deadline=Date.now()+7000;
    do {
      const [run]=await otherDb.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,runId));
      if(hasManualOwnershipRepairHold(run)) return;
      await new Promise((resolve)=>setTimeout(resolve,10));
    } while(Date.now()<deadline);
    throw new Error("Infrastructure: reaper did not persist the synthetic hold before deadline");
  }

  for(const operation of ["release","clearExecutionRunIfTerminal","clearCheckoutRunIfTerminal","update","tree-cancel"] as const) {
    it(`preserves claims when a hold commits during ${operation}`,async()=>{
      const seeded=await seedConcurrentHoldRace(operation);
      const firstRead=latch(),resume=latch();
      let firstReadRows:any[]=[];
      const intercepted=interceptHoldRead(db,async(rows)=>{
        firstReadRows=rows;
        firstRead.resolve();
        await resume.promise;
      });
      const service=issueService(intercepted);
      const tree=issueTreeControlService(intercepted);
      const cancelHold=operation==="tree-cancel"
        ? (await issueTreeControlService(db).createHold(seeded.companyId,seeded.issueId,{
            mode:"cancel",reason:"Synthetic concurrent hold",actor:treeActor,
          })).hold
        : null;

      const work=operation==="release"
        ? request(issueApp(intercepted)).post(`/api/issues/${seeded.issueId}/release`)
            .set("authorization",`Bearer ${seeded.token}`)
            .set("x-paperclip-run-id",seeded.runId)
            .then((response)=>({httpStatus:response.status,body:response.body}))
        : operation==="update"
          ? service.update(seeded.issueId,{status:"todo"})
          : operation==="tree-cancel"
            ? tree.cancelIssueStatusesForHold(seeded.companyId,seeded.issueId,cancelHold!.id)
            : service[operation](seeded.issueId);
      const completed=Promise.resolve(work).then(
        (value)=>({value}),
        (error)=>({error:{status:error?.status,message:error instanceof Error?error.message:String(error)}}),
      );

      await Promise.race([
        firstRead.promise,
        new Promise((_,reject)=>setTimeout(()=>reject(new Error("Hold guard read was not reached")),7000)),
      ]);
      const reaper=heartbeatService(otherDb,{hostPlatform:"win32"}).reapOrphanedRuns();
      try {
        await waitForHoldMarker(seeded.runId);
      } finally {
        resume.resolve();
      }
      const result=await completed;
      await reaper;

      const [run]=await otherDb.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,seeded.runId));
      const [issue]=await otherDb.select().from(issues).where(eq(issues.id,seeded.issueId));
      const [wake]=await otherDb.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,seeded.wakeId));
      const allRuns=await otherDb.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId,seeded.companyId));
      recordReleaseHoldObservation({case:`concurrent_${operation}`,firstReadRows,result,
        run:{status:run.status,errorCode:run.errorCode,manualRepairRequired:run.resultJson?.manualRepairRequired},
        issue:{status:issue.status,checkoutRunId:issue.checkoutRunId,executionRunId:issue.executionRunId,
          assigneeAgentId:issue.assigneeAgentId},wake:{status:wake.status,runId:wake.runId},runCount:allRuns.length});

      expect(run).toMatchObject({status:"failed",errorCode:"process_ownership_unverified",
        resultJson:expect.objectContaining({manualRepairRequired:true})});
      expect(issue).toMatchObject({status:"blocked",assigneeAgentId:seeded.agentId,
        checkoutRunId:seeded.runId,executionRunId:seeded.runId});
      expect(wake).toMatchObject({status:"deferred_issue_execution",runId:null});
      expect(allRuns).toHaveLength(1);
      expect(mocks.execute).not.toHaveBeenCalled();
      if(operation==="release") expect(result).toMatchObject({value:{httpStatus:409}});
      else expect(result).toMatchObject({error:{status:409}});
      runningProcesses.delete(seeded.runId);
      expect(await heartbeatService(otherDb).reconcileTerminalRuns()).toEqual({completed:1,pending:0});
    },20000);
  }

  it("allows authenticated ordinary release when the terminal run has no ownership-repair hold",async()=>{
    const companyId=randomUUID(),agentId=randomUUID(),runId=randomUUID(),issueId=randomUUID();
    const now=new Date("2026-01-01T01:00:00.000Z");
    await db.insert(companies).values({id:companyId,name:"Synthetic ordinary release",issuePrefix:`R${runId.slice(0,6)}`});
    await db.insert(agents).values({id:agentId,companyId,name:"Synthetic releaser",role:"engineer",status:"idle",
      adapterType:"codex_local",adapterConfig:{},runtimeConfig:{heartbeat:{wakeOnDemand:true}},permissions:{}});
    await db.insert(heartbeatRuns).values({id:runId,companyId,agentId,status:"succeeded",startedAt:now,finishedAt:now,
      contextSnapshot:{issueId}});
    await db.insert(issues).values({id:issueId,companyId,title:"Synthetic ordinary release",status:"blocked",
      assigneeAgentId:agentId,checkoutRunId:runId,executionAgentNameKey:"synthetic releaser",executionRunId:runId,
      executionLockedAt:now});
    const token=randomUUID()+randomUUID();
    await db.insert(agentApiKeys).values({agentId,companyId,name:"Synthetic ordinary release probe",
      keyHash:createHash("sha256").update(token).digest("hex")});

    const app=express();
    app.use(express.json());
    app.use(actorMiddleware(db,{deploymentMode:"authenticated"}));
    app.use(boardMutationGuard());
    app.use("/api",issueRoutes(db,{} as any));
    app.use(errorHandler);
    const response=await request(app)
      .post(`/api/issues/${issueId}/release`)
      .set("authorization",`Bearer ${token}`)
      .set("x-paperclip-run-id",runId);
    expect(response.status).toBe(200);

    const [releasedIssue]=await db.select().from(issues).where(eq(issues.id,issueId));
    expect(releasedIssue).toMatchObject({status:"todo",assigneeAgentId:null,checkoutRunId:null,
      executionRunId:null,executionAgentNameKey:null,executionLockedAt:null});
    const releaseAudit=await db.select().from(activityLog).where(eq(activityLog.entityId,issueId));
    expect(releaseAudit).toContainEqual(expect.objectContaining({
      actorType:"agent",actorId:agentId,agentId,runId,action:"issue.released",
    }));
    recordReleaseHoldObservation({
      case:"ordinary_release_without_hold",
      ordinaryHttpStatus:response.status,
      statusAfter:releasedIssue.status,
      assigneeAfter:releasedIssue.assigneeAgentId,
      checkoutRunIdAfter:releasedIssue.checkoutRunId,
      executionRunIdAfter:releasedIssue.executionRunId,
      auditCount:releaseAudit.filter((entry)=>entry.action==="issue.released").length,
    });
  },20000);

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
