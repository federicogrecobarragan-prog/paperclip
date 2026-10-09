import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { terminalProcessCandidatePage, TERMINAL_PROCESS_BATCH_SIZE } from "../services/terminal-process-candidates.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), terminate: vi.fn(async () => {}), birth: vi.fn() }));
vi.mock("../services/run-spawn-guard.js", async () => {
  const actual = await vi.importActual<typeof import("../services/run-spawn-guard.js")>("../services/run-spawn-guard.js");
  return { ...actual, readProcessBirth: mocks.birth };
});
vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js");
  return { ...actual, getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: mocks.execute }) };
});
vi.mock("../services/local-service-supervisor.js", async () => {
  const actual = await vi.importActual<typeof import("../services/local-service-supervisor.js")>("../services/local-service-supervisor.js");
  return { ...actual, terminateLocalService: mocks.terminate };
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Embedded Postgres unavailable: ${support.reason}`);
(support.supported ? describe : describe.skip)("heartbeat late spawn cancellation with database", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("synthetic-spawn-cancel-");
    db = createDb(tempDb.connectionString);
  }, 30_000);
  afterAll(async () => { await tempDb?.cleanup(); });
  it("does not stamp terminal metadata and terminates the newly born child", async () => {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic testing", issuePrefix: "SYN",
      requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic worker", role: "engineer",
      status: "active", adapterType: "claude_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    const entered = deferred(), allowSpawn = deferred(), spawned = deferred(), finish = deferred();
    mocks.execute.mockImplementationOnce(async (context) => {
      entered.resolve();
      await allowSpawn.promise;
      await context.onSpawn({ pid: 424242, processGroupId: null, startedAt: new Date().toISOString() });
      spawned.resolve();
      await finish.promise;
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Synthetic result" };
    });
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId);
    expect(run).toBeTruthy();
    try {
      await entered.promise;
      const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
      expect(before.status).toBe("running");
      expect(before.processPid).toBeNull();
      await heartbeat.cancelRun(run!.id);
      allowSpawn.resolve();
      await spawned.promise;
      const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
      expect(after.status).toBe("cancelled");
      expect(after.processStartedAt).toBeNull();
      expect(after.processPid).toBeNull();
      expect(mocks.terminate).toHaveBeenCalledWith(expect.objectContaining({ pid: 424242 }), undefined);
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run!.id));
      expect(events.some(event => event.message?.includes("Rejected late child spawn"))).toBe(true);
    } finally { allowSpawn.resolve(); finish.resolve(); }
  }, 20_000);
  async function terminalRun(driver: string | null = "local") {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic reaper", issuePrefix: `T${runId.slice(0,6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic child", role: "engineer",
      status: "active", adapterType: "claude_local", adapterConfig: {}, permissions: {} });
    const recorded = new Date("2026-01-01T00:00:00.000Z");
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "cancelled",
      processPid: 424242, processStartedAt: recorded, finishedAt: new Date(recorded.getTime()+1000),
      contextSnapshot: driver ? { paperclipEnvironment: { driver } } : {} });
    return { runId, recorded };
  }
  it("skips a terminal PID whose real process was born after the recorded child", async () => {
    const { recorded } = await terminalRun();
    mocks.birth.mockResolvedValue(new Date(recorded.getTime()+1));
    mocks.terminate.mockClear();
    const kill = vi.spyOn(process,"kill").mockReturnValue(true);
    try {
      await heartbeatService(db).reapOrphanedRuns();
      expect(mocks.terminate).not.toHaveBeenCalled();
    } finally { kill.mockRestore(); }
  });
  it("reaps a matching terminal child only once", async () => {
    const { runId, recorded } = await terminalRun();
    mocks.birth.mockResolvedValue(new Date(recorded.getTime()-100));
    mocks.terminate.mockClear();
    const kill = vi.spyOn(process,"kill").mockReturnValue(true);
    try {
      const heartbeat = heartbeatService(db);
      await heartbeat.reapOrphanedRuns();
      const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,runId));
      expect(after.processPid).toBeNull();
      const count = mocks.terminate.mock.calls.length;
      expect(count).toBeGreaterThan(0);
      await heartbeat.reapOrphanedRuns();
      expect(mocks.terminate).toHaveBeenCalledTimes(count);
    } finally { kill.mockRestore(); }
  });
  it.each(["sandbox", "plugin", null])("does not probe or terminate a terminal provider/unknown PID (%s)", async (driver) => {
    await terminalRun(driver);
    mocks.birth.mockClear();
    mocks.terminate.mockClear();
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      await heartbeatService(db).reapOrphanedRuns();
      expect(mocks.birth).not.toHaveBeenCalled();
      expect(mocks.terminate).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
    } finally { kill.mockRestore(); }
  });

  it("keeps large historical payloads in PostgreSQL and visits every terminal page", async () => {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic history", issuePrefix: "HIST" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic history owner", role: "engineer",
      status: "paused", adapterType: "claude_local", adapterConfig: {}, permissions: {} });
    const ids = Array.from({ length: TERMINAL_PROCESS_BATCH_SIZE + 11 }, () => randomUUID());
    const payload = "HISTORY_MUST_STAY_IN_POSTGRES".repeat(80_000);
    await db.insert(heartbeatRuns).values(ids.map((id, index) => ({
      id, companyId, agentId, status: "cancelled", processPid: 424242,
      processStartedAt: new Date("2026-01-01T00:00:00Z"),
      contextSnapshot: { paperclipEnvironment: { driver: index % 2 ? "ssh" : "local" }, prompt: index ? "small" : payload },
      resultJson: index ? {} : { transcript: payload },
    })));
    const visited: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      expect(++pages).toBeLessThanOrEqual(4);
      const page = await terminalProcessCandidatePage(db, ["queued", "running", "scheduled_retry"], cursor);
      expect(page.length).toBeLessThanOrEqual(TERMINAL_PROCESS_BATCH_SIZE);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(110_000);
      for (const candidate of page) {
        if (ids.includes(candidate.run.id)) {
          visited.push(candidate.run.id);
          expect(candidate.run.contextSnapshot).toEqual({ paperclipEnvironment: { driver: expect.stringMatching(/^(local|ssh)$/) } });
        }
      }
      if (!page.length) break;
      cursor = page[page.length - 1]!.run.id;
    }
    expect(new Set(visited).size).toBe(ids.length);
    expect(visited.length).toBe(ids.length);
    const [stored] = await db.select({ result: heartbeatRuns.resultJson }).from(heartbeatRuns).where(eq(heartbeatRuns.id, ids[0]!));
    expect(stored.result).toEqual({ transcript: payload });
    // Clear this test's candidates only; subsequent guards retain their own fixtures.
    await db.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.companyId, companyId));
  });

  it("coalesces overlapping reapers and admits a new sweep after failure", async () => {
    await terminalRun();
    const entered = deferred(), release = deferred();
    mocks.birth.mockReset();
    mocks.birth.mockImplementationOnce(async () => {
      entered.resolve(); await release.promise; throw new Error("synthetic birth probe failure");
    });
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      const heartbeat = heartbeatService(db);
      const first = heartbeat.reapOrphanedRuns();
      await entered.promise;
      const second = heartbeat.reapOrphanedRuns();
      const settled = Promise.allSettled([first, second]);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(mocks.birth).toHaveBeenCalledTimes(1);
      release.resolve();
      expect((await settled).map(result => result.status)).toEqual(["rejected", "rejected"]);
      mocks.birth.mockResolvedValue(null);
      await heartbeat.reapOrphanedRuns();
      expect(mocks.birth.mock.calls.length).toBeGreaterThan(1);
    } finally { release.resolve(); kill.mockRestore(); }
  });
});
