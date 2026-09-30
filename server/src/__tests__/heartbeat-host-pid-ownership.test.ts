import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, agentRuntimeState, agentWakeupRequests, companies, companySkills, createDb,
  environmentLeases, environments, executionWorkspaces, workspaceOperations,
  heartbeatRunEvents, heartbeatRuns, issueComments, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { runningProcesses } from "../adapters/index.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), birth: vi.fn(), terminate: vi.fn(), sweep: vi.fn() }));
vi.mock("../services/run-spawn-guard.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/run-spawn-guard.js")>(), readProcessBirth: mocks.birth,
}));
vi.mock("../adapters/index.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../adapters/index.js")>(),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: mocks.execute }),
}));
vi.mock("../services/local-service-supervisor.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/local-service-supervisor.js")>(), terminateLocalService: mocks.terminate,
}));
vi.mock("@paperclipai/adapter-utils/windows-process-tree", async (importOriginal) => ({
  ...await importOriginal<typeof import("@paperclipai/adapter-utils/windows-process-tree")>(), terminateWindowsOrphanedDescendants: mocks.sweep,
}));

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Embedded Postgres unavailable: ${support.reason}`);
(support.supported ? describe : describe.skip)("restart host PID ownership", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService> | undefined;
  const fixtureCompanies: string[] = [];
  const children: ChildProcess[] = [];
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("synthetic-host-pid-"); db = createDb(temp.connectionString); }, 30_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    await heartbeat?.stopAndDrain();
    heartbeat = undefined;
    for (const child of children.splice(0)) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    runningProcesses.clear();
    for (const companyId of fixtureCompanies.splice(0)) {
      for (const table of [environmentLeases, workspaceOperations, heartbeatRunEvents, activityLog, companySkills,
        issueComments, issues, heartbeatRuns, agentWakeupRequests, agentRuntimeState, agents, executionWorkspaces]) {
        await db.delete(table).where(eq(table.companyId, companyId));
      }
      await db.delete(companies).where(eq(companies.id, companyId));
    }
    // Environments have no company column; this database belongs only to this suite.
    await db.delete(environments);
    for (const mock of Object.values(mocks)) mock.mockReset();
  });
  afterAll(async () => { await temp?.cleanup(); });

  async function fixture(driver: string | null, pid: number, recorded: Date, adapterType = "grok_local") {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    fixtureCompanies.push(companyId);
    await db.insert(companies).values({ id: companyId, name: "Synthetic ownership", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer", status: "running", adapterType,
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true } }, permissions: {} });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", processPid: pid,
      processStartedAt: recorded, startedAt: recorded, updatedAt: recorded, processLossRetryCount: 1,
      contextSnapshot: { issueId, ...(driver ? { paperclipEnvironment: { driver } } : {}) } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic claim", status: "in_progress",
      assigneeAgentId: agentId, executionAgentNameKey: "fixture", executionRunId: runId });
    heartbeat = heartbeatService(db);
    return { companyId, agentId, runId, issueId };
  }

  it.each(["local", "ssh"])("keeps the original live grok child and claim after restart (%s)", async (driver) => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
    children.push(child);
    await once(child, "spawn");
    const actual = await vi.importActual<typeof import("../services/run-spawn-guard.js")>("../services/run-spawn-guard.js");
    const birth = await actual.readProcessBirth(child.pid!);
    expect(birth).not.toBeNull();
    mocks.birth.mockResolvedValue(birth);
    const ids = await fixture(driver, child.pid!, birth!);
    const kill = vi.spyOn(process, "kill");
    expect(await heartbeat!.reapOrphanedRuns()).toEqual({ reaped: 0, runIds: [] });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ids.runId)))[0]).toMatchObject({ status: "running", errorCode: "process_detached" });
    expect((await db.select().from(issues).where(eq(issues.id, ids.issueId)))[0]?.executionRunId).toBe(ids.runId);
    expect(mocks.terminate).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(kill.mock.calls.filter((call) => call[1] !== 0)).toEqual([]);
  });

  it.each(["recycled", "unknown"])("holds work for manual repair instead of accepting an unverified live PID (%s)", async (kind) => {
    const recorded = new Date("2026-01-01T00:00:00Z");
    mocks.birth.mockResolvedValue(kind === "recycled" ? new Date(recorded.getTime() + 60_000) : null);
    const ids = await fixture("local", 999_999_999, recorded);
    vi.spyOn(process, "kill").mockReturnValue(true);
    await heartbeat!.reapOrphanedRuns();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ids.runId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, ids.issueId));
    const [agent] = await db.select().from(agents).where(eq(agents.id, ids.agentId));
    expect(run).toMatchObject({ status: "failed", errorCode: "process_ownership_unverified", resultJson: { manualRepairRequired: true } });
    expect(issue).toMatchObject({ status: "blocked", executionRunId: ids.runId });
    expect(agent.status).toBe("paused");
    expect(mocks.terminate).not.toHaveBeenCalled();
    expect(mocks.sweep).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each(["sandbox", "plugin", null])("does not probe provider or unknown PID namespaces after restart (%s)", async (driver) => {
    const ids = await fixture(driver, 999_999_999, new Date("2026-01-01T00:00:00Z"));
    // Existing provider recovery can schedule a continuation. Pause this fixture to
    // isolate the host-probe barrier without dispatching unrelated work.
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, ids.agentId));
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    await heartbeat!.reapOrphanedRuns();
    expect(kill).not.toHaveBeenCalled();
    expect(mocks.birth).not.toHaveBeenCalled();
    expect(mocks.terminate).not.toHaveBeenCalled();
    expect(mocks.sweep).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
