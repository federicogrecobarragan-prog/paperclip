import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRelations,
  issues,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() => vi.fn());

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import * as activityLogService from "../services/activity-log.ts";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping heartbeat U+0000 PostgreSQL tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForTerminalRun(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return heartbeat.getRun(runId);
}

async function waitForPostTerminalState(
  db: ReturnType<typeof createDb>,
  agentId: string,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [runtimeState] = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId));
    const sessions = await db
      .select()
      .from(agentTaskSessions)
      .where(eq(agentTaskSessions.agentId, agentId));
    if (runtimeState?.lastRunId === runId && sessions.some((session) => session.lastRunId === runId)) {
      return { runtimeState, sessions };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const [runtimeState] = await db
    .select()
    .from(agentRuntimeState)
    .where(eq(agentRuntimeState.agentId, agentId));
  const sessions = await db
    .select()
    .from(agentTaskSessions)
    .where(eq(agentTaskSessions.agentId, agentId));
  return { runtimeState, sessions };
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return fn();
}

async function waitForHeartbeatQuiescence(
  db: ReturnType<typeof createDb>,
  timeoutMs = 10_000,
) {
  const isQuiescent = async () => {
    const [activeRuns, activeWakeups, activeAgents] = await Promise.all([
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["queued", "running"])),
      db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(inArray(agentWakeupRequests.status, ["queued", "claimed"])),
      db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.status, "running")),
    ]);
    return activeRuns.length === 0 && activeWakeups.length === 0 && activeAgents.length === 0;
  };

  if (!await waitForCondition(isQuiescent, timeoutMs)) {
    throw new Error("Heartbeat test database did not become quiescent");
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (!await waitForCondition(isQuiescent, timeoutMs)) {
    throw new Error("Heartbeat test database did not remain quiescent");
  }
}

describeEmbeddedPostgres("heartbeat U+0000 PostgreSQL persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let releaseBlockedFollowUps: (() => void) | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-nul-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  afterEach(async () => {
    releaseBlockedFollowUps?.();
    releaseBlockedFollowUps = null;
    await waitForHeartbeatQuiescence(db);
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (tempDb) await waitForHeartbeatQuiescence(db);
    await db?.$client.end({ timeout: 0 });
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "NUL persistence test",
      issuePrefix: `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "NULAdapter",
      role: "test",
      status: "idle",
      adapterType: "http",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("persists sanitized result, logs, events, wake payload, context, runtime state, and session", async () => {
    const { agentId } = await seedAgent();
    mockAdapterExecute.mockImplementationOnce(async (context: {
      onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
      onMeta?: (meta: Record<string, unknown>) => Promise<void>;
    }) => {
      await context.onLog("stdout", "stdout\u0000payload");
      await context.onLog("stderr", "stderr\u0000payload");
      await context.onMeta?.({
        adapterType: "http",
        command: "test\u0000command",
        context: { "meta\u0000key": "meta\u0000value" },
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "summary\u0000value",
        provider: "provider\u0000value",
        model: "model\u0000value",
        sessionId: "session\u0000legacy",
        sessionDisplayId: "session\u0000display",
        sessionParams: { "session\u0000key": "session\u0000value" },
        resultJson: { "result\u0000key": ["result\u0000value"] },
      };
    });
    const heartbeat = heartbeatService(db);

    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "system",
      reason: "reason\u0000value",
      payload: { "payload\u0000key": "payload\u0000value" },
      contextSnapshot: {
        taskKey: "task\u0000key",
        "context\u0000key": "context\u0000value",
      },
    });
    expect(queued).toBeTruthy();
    const terminal = await waitForTerminalRun(heartbeat, queued!.id);
    const { runtimeState, sessions } = await waitForPostTerminalState(db, agentId, queued!.id);

    expect(terminal?.status).toBe("succeeded");
    const [wakeup] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.runId, queued!.id));
    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, queued!.id));
    const log = await heartbeat.readLog(queued!.id);

    const persisted = JSON.stringify({ terminal, wakeup, events, runtimeState, sessions, log });
    expect(persisted).not.toContain("\u0000");
    expect(persisted).toContain("\uFFFD");
    expect(terminal?.resultJson).toMatchObject({ "result\uFFFDkey": ["result\uFFFDvalue"] });
    expect(terminal?.stdoutExcerpt).toContain("stdout\uFFFDpayload");
    expect(terminal?.stderrExcerpt).toContain("stderr\uFFFDpayload");
    expect(wakeup?.status).toBe("completed");
    expect(sessions).toHaveLength(1);
  });

  it("fails the full run when a known optional field is accessor-backed without executing it", async () => {
    const { agentId } = await seedAgent();
    let getterCalls = 0;
    mockAdapterExecute.mockImplementationOnce(async () => {
      const result: Record<string, unknown> = {
        exitCode: 0,
        signal: null,
        timedOut: false,
      };
      Object.defineProperty(result, "errorMessage", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return null;
        },
      });
      return result;
    });
    const heartbeat = heartbeatService(db);

    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "system",
    });
    expect(queued).toBeTruthy();
    const terminal = await waitForTerminalRun(heartbeat, queued!.id);
    const [wakeup] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.runId, queued!.id));

    expect(getterCalls).toBe(0);
    expect(terminal?.status).toBe("failed");
    expect(terminal?.error).toContain("errorMessage must be a data property");
    expect(wakeup?.status).toBe("failed");
    expect(wakeup?.status).not.toBe("completed");
  });

  it("persists an unsigned Windows process code as signed int4 and reaches a terminal state", async () => {
    const { agentId } = await seedAgent();
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 3_221_226_505,
      signal: null,
      timedOut: false,
      errorMessage: "Windows process terminated with 0xC0000409",
    });
    const heartbeat = heartbeatService(db);

    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "system",
    });
    expect(queued).toBeTruthy();
    const terminal = await waitForTerminalRun(heartbeat, queued!.id);
    await waitForCondition(async () => {
      const [currentWakeup] = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.runId, queued!.id));
      return currentWakeup?.status === "failed";
    });
    const [wakeup] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.runId, queued!.id));
    const active = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, queued!.id),
        inArray(heartbeatRuns.status, ["queued", "running"]),
      ));

    expect(terminal?.status).toBe("failed");
    expect(terminal?.exitCode).toBe(-1_073_740_791);
    expect(terminal?.error).toContain("0xC0000409");
    expect(wakeup?.status).toBe("failed");
    expect(active).toHaveLength(0);
  });

  it("fails closed on an invalid runtime-service report and fabricates no service", async () => {
    const { companyId, agentId } = await seedAgent();
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      runtimeServices: [{}],
    });
    const heartbeat = heartbeatService(db);

    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "system",
    });
    expect(queued).toBeTruthy();
    const terminal = await waitForTerminalRun(heartbeat, queued!.id);
    const persistedServices = await db
      .select()
      .from(workspaceRuntimeServices)
      .where(eq(workspaceRuntimeServices.companyId, companyId));

    expect(terminal?.status).toBe("failed");
    expect(terminal?.status).not.toBe("succeeded");
    expect(terminal?.error).toContain("runtimeServices[0].serviceName is required");
    expect(persistedServices).toHaveLength(0);
  });

  it("redacts synthetic secrets from the row, event, snapshot, wakeup, and log", async () => {
    const { agentId } = await seedAgent();
    const syntheticSentinel = "sk-syntheticfixture123456789";
    mockAdapterExecute.mockImplementationOnce(async (context: {
      onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    }) => {
      await context.onLog("stderr", `Authorization: Bearer ${syntheticSentinel}`);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `token=${syntheticSentinel}`,
        resultJson: {
          apiKey: syntheticSentinel,
          detail: `Authorization: Bearer ${syntheticSentinel}`,
        },
      };
    });
    const heartbeat = heartbeatService(db);

    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "system",
      payload: { apiKey: syntheticSentinel },
      contextSnapshot: {
        nested: { authorization: syntheticSentinel },
        note: `token=${syntheticSentinel}`,
      },
    });
    expect(queued).toBeTruthy();
    const terminal = await waitForTerminalRun(heartbeat, queued!.id);
    const [wakeup] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.runId, queued!.id));
    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, queued!.id));
    const log = await heartbeat.readLog(queued!.id);
    const persisted = JSON.stringify({ terminal, wakeup, events, log });

    expect(terminal?.status).toBe("failed");
    expect(persisted).not.toContain(syntheticSentinel);
    expect(persisted).toContain("***REDACTED***");
  });

  it("continues wake, lock promotion, dependency scheduling, runtime, and session finalization when publication throws", async () => {
    const { companyId, agentId } = await seedAgent();
    const dependentAgentId = randomUUID();
    const blockerIssueId = randomUUID();
    const dependentIssueId = randomUUID();
    await db.insert(agents).values({
      id: dependentAgentId,
      companyId,
      name: "DependentAdapter",
      role: "test",
      status: "idle",
      adapterType: "http",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        title: "Terminal publication blocker",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
      },
      {
        id: dependentIssueId,
        companyId,
        title: "Terminal publication dependent",
        status: "blocked",
        priority: "high",
        assigneeAgentId: dependentAgentId,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: dependentIssueId,
      type: "blocks",
    });

    let firstRunStarted!: () => void;
    const firstRunStartedPromise = new Promise<void>((resolve) => {
      firstRunStarted = resolve;
    });
    let finishFirstRun!: () => void;
    const firstRunCanFinish = new Promise<void>((resolve) => {
      finishFirstRun = resolve;
    });
    let finishFollowUpRuns!: () => void;
    const followUpRunsCanFinish = new Promise<void>((resolve) => {
      finishFollowUpRuns = resolve;
    });
    releaseBlockedFollowUps = finishFollowUpRuns;
    mockAdapterExecute.mockImplementationOnce(async () => {
      firstRunStarted();
      await firstRunCanFinish;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "terminal persisted",
        provider: "test",
        model: "test-model",
        sessionId: "terminal-session",
      };
    });
    mockAdapterExecute.mockImplementation(async () => {
      await followUpRunsCanFinish;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "follow-up completed",
        provider: "test",
        model: "test-model",
      };
    });
    vi.spyOn(activityLogService, "publishPluginDomainEvent").mockImplementation((event) => {
      if (event.eventType === "agent.run.finished") throw new Error("simulated post-commit publication failure");
    });
    const heartbeat = heartbeatService(db);

    const queued = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: blockerIssueId },
      contextSnapshot: {
        issueId: blockerIssueId,
        taskKey: `issue:${blockerIssueId}`,
        wakeReason: "issue_assigned",
      },
    });
    expect(queued).toBeTruthy();
    await firstRunStartedPromise;

    const deferredWakeupId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeupId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: {
        issueId: blockerIssueId,
        _paperclipWakeContext: {
          issueId: blockerIssueId,
          taskKey: `issue:${blockerIssueId}`,
          wakeReason: "issue_commented",
        },
      },
      status: "deferred_issue_execution",
    });
    const deferredRecorded = await waitForCondition(async () => {
      const row = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, deferredWakeupId))
        .then((rows) => rows[0] ?? null);
      return row?.status === "deferred_issue_execution";
    });
    expect(deferredRecorded).toBe(true);

    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(issues.id, blockerIssueId));
    finishFirstRun();

    const terminal = await waitForTerminalRun(heartbeat, queued!.id);
    const postTerminalState = await waitForPostTerminalState(db, agentId, queued!.id);
    const finalizedSideEffects = await waitForCondition(async () => {
      const [originalWakeup] = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.runId, queued!.id));
      const promotedWakeup = await db
        .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.reason, "issue_execution_promoted"),
        ))
        .then((rows) => rows[0] ?? null);
      const dependentWakeup = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.agentId, dependentAgentId),
          eq(agentWakeupRequests.reason, "issue_blockers_resolved"),
        ))
        .then((rows) => rows[0] ?? null);
      return originalWakeup?.status === "completed" &&
        Boolean(promotedWakeup?.runId) &&
        Boolean(dependentWakeup);
    });
    expect(finalizedSideEffects).toBe(true);

    const reconciled = await heartbeat.getRun(queued!.id);
    const [originalWakeup] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.runId, queued!.id));
    const promotedWakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.agentId, agentId),
        eq(agentWakeupRequests.reason, "issue_execution_promoted"),
      ))
      .then((rows) => rows[0]);
    const [sourceIssueWhilePromoted] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, blockerIssueId));
    const promotedRun = promotedWakeup?.runId
      ? await heartbeat.getRun(promotedWakeup.runId)
      : null;

    expect(terminal?.status).toBe("succeeded");
    expect(reconciled?.status).toBe("succeeded");
    expect(reconciled?.errorCode).not.toBe("process_lost");
    expect(originalWakeup?.status).toBe("completed");
    expect(promotedWakeup?.runId).toBeTruthy();
    expect(promotedWakeup?.runId).not.toBe(queued!.id);
    expect(sourceIssueWhilePromoted?.checkoutRunId).toBeNull();
    expect(sourceIssueWhilePromoted?.executionRunId).toBeNull();
    expect(promotedRun?.status).toBe("cancelled");
    expect(promotedRun?.errorCode).toBe("issue_terminal_status");
    expect(postTerminalState.runtimeState?.lastRunId).toBe(queued!.id);
    expect(postTerminalState.sessions.some((session) => session.lastRunId === queued!.id)).toBe(true);

    finishFollowUpRuns();
    releaseBlockedFollowUps = null;
    const followUpsFinished = await waitForCondition(async () => {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["queued", "running"]));
      return active.length === 0;
    });
    expect(followUpsFinished).toBe(true);
    const [sourceIssueAfterPromotion] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, blockerIssueId));
    expect(sourceIssueAfterPromotion?.executionRunId).toBeNull();
  });
});
