import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  approvals,
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  budgetPolicies,
  budgetIncidents,
  companies,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRelations,
  issues,
  workspaceOperations,
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
import * as liveEventsService from "../services/live-events.ts";
import {
  heartbeatService,
  type HeartbeatPostTerminalStep,
  type HeartbeatRuntimeAccountingFaultPhase,
} from "../services/heartbeat.ts";
import { logger } from "../middleware/logger.ts";
import { workspaceOperationService } from "../services/workspace-operations.ts";
import { costService } from "../services/costs.ts";

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
    try {
      await waitForHeartbeatQuiescence(db);
    } finally {
      vi.clearAllMocks();
      vi.restoreAllMocks();
    }
  });

  afterAll(async () => {
    try {
      if (tempDb) await waitForHeartbeatQuiescence(db);
    } finally {
      await db?.$client.end({ timeout: 0 });
      await tempDb?.cleanup();
    }
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

  it("preserves task session continuity when heartbeat history is deleted", async () => {
    const { companyId, agentId } = await seedAgent();
    const runId = randomUUID();
    const taskKey = `issue:${randomUUID()}`;

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
    });
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "http",
      taskKey,
      sessionParamsJson: { sessionId: "retained-session" },
      sessionGeneration: 3,
      lastRunId: runId,
    });

    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId));

    const [session] = await db
      .select()
      .from(agentTaskSessions)
      .where(eq(agentTaskSessions.taskKey, taskKey));
    expect(session).toMatchObject({
      taskKey,
      sessionParamsJson: { sessionId: "retained-session" },
      sessionGeneration: 3,
      lastRunId: null,
    });

    await db.delete(agents).where(eq(agents.id, agentId));
    expect(
      await db
        .select()
        .from(agentTaskSessions)
        .where(eq(agentTaskSessions.taskKey, taskKey)),
    ).toHaveLength(0);
  });

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

  it("preserves sensitive-looking keys in opaque adapter session params and reports the exception", async () => {
    const { agentId } = await seedAgent();
    const taskKey = `issue:${randomUUID()}`;
    const warningSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionParams: {
        authToken: "resume-handle-alpha",
        nested: { cookie: "resume-handle-beta" },
      },
      sessionDisplayId: "opaque-session",
    });
    const heartbeat = heartbeatService(db);

    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "system",
      contextSnapshot: { taskKey },
    });
    expect(queued).toBeTruthy();
    expect((await waitForTerminalRun(heartbeat, queued!.id))?.status).toBe("succeeded");
    const { sessions } = await waitForPostTerminalState(db, agentId, queued!.id);
    const terminal = await heartbeat.getRun(queued!.id);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionParamsJson).toMatchObject({
      authToken: "resume-handle-alpha",
      nested: { cookie: "resume-handle-beta" },
    });
    expect(terminal?.terminalFinalizationJson).toMatchObject({
      session: {
        params: {
          authToken: "resume-handle-alpha",
          nested: { cookie: "resume-handle-beta" },
        },
      },
    });
    expect(warningSpy).toHaveBeenCalledWith(
      expect.objectContaining({ adapterType: "http", sensitiveKeyExceptions: expect.any(Number) }),
      "preserved sensitive-looking adapter session parameter keys in durable terminal state",
    );
    const warningContext = warningSpy.mock.calls.find(([, message]) =>
      message === "preserved sensitive-looking adapter session parameter keys in durable terminal state"
    )?.[0] as { sensitiveKeyExceptions?: number } | undefined;
    expect(warningContext?.sensitiveKeyExceptions).toBeGreaterThanOrEqual(2);

    mockAdapterExecute.mockRejectedValueOnce(new Error("synthetic adapter failure"));
    const failed = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "system",
      contextSnapshot: { taskKey },
    });
    expect(failed).toBeTruthy();
    expect((await waitForTerminalRun(heartbeat, failed!.id))?.status).toBe("failed");
    const failedState = await waitForPostTerminalState(db, agentId, failed!.id);
    const failedTerminal = await heartbeat.getRun(failed!.id);

    expect(failedState.sessions).toHaveLength(1);
    expect(failedState.sessions[0]?.sessionParamsJson).toMatchObject({
      authToken: "resume-handle-alpha",
      nested: { cookie: "resume-handle-beta" },
    });
    expect(failedTerminal?.terminalFinalizationJson).toMatchObject({
      session: {
        params: {
          authToken: "resume-handle-alpha",
          nested: { cookie: "resume-handle-beta" },
        },
      },
    });
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
    expect(await waitForCondition(async () => {
      const row = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.runId, queued!.id))
        .then((rows) => rows[0] ?? null);
      return row?.status === "failed";
    })).toBe(true);
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

  it("redacts control-split secrets from terminal DB fields, result JSON, wake data, and logs", async () => {
    const { agentId } = await seedAgent();
    const opaqueCanaries = {
      log: "OpaqueValueQ9Z8R7M4V2A",
      error: "OpaqueValueQ9Z8R7M4V2B",
      payloadKey: "OpaqueValueQ9Z8R7M4V2C",
      commandArgs: "OpaqueValueQ9Z8R7M4V2D",
      argv: "OpaqueValueQ9Z8R7M4V2E",
      splitFlag: "OpaqueValueQ9Z8R7M4V2F",
      boxedFlag: "OpaqueValueQ9Z8R7M4V2G",
    };
    mockAdapterExecute.mockImplementationOnce(async (context: {
      onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    }) => {
      await context.onLog("stderr", `token\u0000=${opaqueCanaries.log}`);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `api\u0000key=${opaqueCanaries.error}`,
        resultJson: {
          ["api\u0000Key"]: opaqueCanaries.payloadKey,
          ["command\u0000Args"]: ["--api-key", opaqueCanaries.commandArgs, "safe-next"],
          ["ar\u0000gv"]: ["--api-key", opaqueCanaries.argv, "safe-next"],
          commandArgs: ["--access\u0000token", opaqueCanaries.splitFlag, "safe-next"],
          boxedArgs: {
            argv: [new String("--api-key"), opaqueCanaries.boxedFlag, "safe-next"],
          },
        },
      };
    });
    const heartbeat = heartbeatService(db);

    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "system",
      payload: { ["api\u0000Key"]: opaqueCanaries.payloadKey },
      contextSnapshot: {
        ["command\u0000Args"]: ["--api-key", opaqueCanaries.commandArgs, "safe-next"],
        ["ar\u0000gv"]: ["--api-key", opaqueCanaries.argv, "safe-next"],
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
    expect(persisted).not.toContain("\u0000");
    expect(persisted).not.toContain("\\u0000");
    for (const opaqueCanary of Object.values(opaqueCanaries)) {
      expect(persisted).not.toContain(opaqueCanary);
    }
    expect(persisted).toContain("***REDACTED***");
  });

  it("redacts an opaque assignment split across adapter chunks before every sink", async () => {
    const { agentId } = await seedAgent();
    const opaqueCanary = "OpaqueChunkBoundaryQ7N4V8M2R6";
    const liveEventSpy = vi.spyOn(liveEventsService, "publishLiveEvent");
    mockAdapterExecute.mockImplementationOnce(async (context: {
      onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    }) => {
      await context.onLog("stderr", "api");
      await context.onLog("stderr", `Key=\n${opaqueCanary}\n`);
      return { exitCode: 0, signal: null, timedOut: false };
    });
    const heartbeat = heartbeatService(db);

    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "system",
      reason: "split_stream_redaction",
    });
    expect(queued).toBeTruthy();
    const terminal = await waitForTerminalRun(heartbeat, queued!.id);
    const log = await heartbeat.readLog(queued!.id);
    const liveLogPayloads = liveEventSpy.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "heartbeat.run.log" && event.payload.runId === queued!.id);
    const persisted = JSON.stringify({
      stdoutExcerpt: terminal?.stdoutExcerpt,
      stderrExcerpt: terminal?.stderrExcerpt,
      log,
      liveLogPayloads,
    });

    expect(terminal?.status).toBe("succeeded");
    expect(persisted).not.toContain(opaqueCanary);
    expect(persisted).toContain("redacted ambiguous adapter log");
  });

  it("redacts synthetic secrets from thrown adapter errors and workspace-finalize evidence", async () => {
    const { agentId } = await seedAgent();
    const syntheticSentinel = "OpaqueLac1270ValueZ9Q8";
    const loggerErrorSpy = vi.spyOn(logger, "error");
    mockAdapterExecute.mockRejectedValueOnce(
      new Error(`provider failure ${syntheticSentinel}`),
    );
    const heartbeat = heartbeatService(db);

    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "system",
    });
    expect(queued).toBeTruthy();
    const terminal = await waitForTerminalRun(heartbeat, queued!.id);
    const { runtimeState, sessions } = await waitForPostTerminalState(db, agentId, queued!.id);
    const [wakeup] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.runId, queued!.id));
    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, queued!.id));
    const operations = await db
      .select()
      .from(workspaceOperations)
      .where(eq(workspaceOperations.heartbeatRunId, queued!.id));
    const log = await heartbeat.readLog(queued!.id);
    const persisted = JSON.stringify({
      terminal,
      wakeup,
      events,
      operations,
      runtimeState,
      sessions,
      log,
    });

    expect(terminal?.status).toBe("failed");
    expect(terminal?.error).toBe("Adapter execution failed; raw provider diagnostic omitted");
    expect(operations.some((operation) => operation.phase === "workspace_finalize")).toBe(true);
    expect(persisted).not.toContain(syntheticSentinel);
    expect(JSON.stringify(loggerErrorSpy.mock.calls)).not.toContain(syntheticSentinel);
  }, 15_000);

  it("rejects spoofed workspace-validation metadata from adapter exceptions", async () => {
    const { agentId } = await seedAgent();
    const syntheticSentinel = "OpaqueSpoofedWorkspaceMetadataR4N8";
    mockAdapterExecute.mockRejectedValueOnce({
      code: "workspace_validation_failed",
      message: syntheticSentinel,
      resultJson: {
        detail: syntheticSentinel,
        workspaceValidation: { note: syntheticSentinel },
      },
    });
    const heartbeat = heartbeatService(db);

    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "system",
    });
    expect(queued).toBeTruthy();
    const terminal = await waitForTerminalRun(heartbeat, queued!.id);

    expect(terminal?.status).toBe("failed");
    expect(terminal?.errorCode).toBe("adapter_failed");
    expect(terminal?.error).toBe("Adapter execution failed; raw provider diagnostic omitted");
    expect(JSON.stringify(terminal?.resultJson)).not.toContain(syntheticSentinel);
    expect(JSON.stringify(terminal?.resultJson)).not.toContain("workspaceValidation");
  });

  it("omits opaque diagnostics when a workspace operation throws", async () => {
    const { companyId } = await seedAgent();
    const syntheticSentinel = "OpaqueWorkspaceValueK7M4";
    const operationsService = workspaceOperationService(db);
    const recorder = operationsService.createRecorder({ companyId });

    await expect(recorder.recordOperation({
      phase: "workspace_finalize",
      run: async () => {
        throw new Error(`provider failure ${syntheticSentinel}`);
      },
    })).rejects.toThrow("Workspace operation failed; raw diagnostic omitted");

    const [operation] = await db
      .select()
      .from(workspaceOperations)
      .where(eq(workspaceOperations.companyId, companyId));
    expect(operation).toBeTruthy();
    const operationLog = await operationsService.readLog(operation!.id);
    const persisted = JSON.stringify({ operation, operationLog });

    expect(persisted).not.toContain(syntheticSentinel);
    expect(persisted).toContain("Workspace operation failed; raw diagnostic omitted");
  });

  it("omits opaque output from failed workspace command results", async () => {
    const { companyId } = await seedAgent();
    const syntheticSentinel = "OpaqueFailedWorkspaceStreamM5T2";
    const operationsService = workspaceOperationService(db);
    const recorder = operationsService.createRecorder({ companyId });

    const operation = await recorder.recordOperation({
      phase: "workspace_provision",
      run: async () => ({
        status: "failed",
        exitCode: 23,
        stdout: `command stdout ${syntheticSentinel}`,
        stderr: `command stderr ${syntheticSentinel}`,
      }),
    });
    const operationLog = await operationsService.readLog(operation.id);
    const persisted = JSON.stringify({ operation, operationLog });

    expect(operation.status).toBe("failed");
    expect(operation.exitCode).toBe(23);
    expect(persisted).not.toContain(syntheticSentinel);
    expect(operation.stdoutExcerpt).toContain("raw stdout omitted");
    expect(operation.stderrExcerpt).toContain("raw stderr omitted");
  });

  for (const faultPhase of [
    "before_transaction",
    "after_runtime_state",
    "after_cost_event",
    "after_commit",
    "after_budget_evaluation",
  ] as const satisfies readonly HeartbeatRuntimeAccountingFaultPhase[]) {
    it(`charges runtime accounting exactly once after a ${faultPhase} failure`, async () => {
      const { companyId, agentId } = await seedAgent();
      await db.insert(budgetPolicies).values({
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 200,
        warnPercent: 50,
        hardStopEnabled: false,
        notifyEnabled: true,
        isActive: true,
      });
      let adapterStarted!: () => void;
      const adapterStartedPromise = new Promise<void>((resolve) => {
        adapterStarted = resolve;
      });
      let finishAdapter!: () => void;
      const adapterCanFinish = new Promise<void>((resolve) => {
        finishAdapter = resolve;
      });
      mockAdapterExecute.mockImplementationOnce(async () => {
        adapterStarted();
        await adapterCanFinish;
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          summary: "accounted once",
          provider: "test",
          biller: "test-biller",
          model: "test-model",
          billingType: "metered_api",
          costUsd: 1.23,
          usage: {
            inputTokens: 101,
            cachedInputTokens: 7,
            outputTokens: 29,
          },
        };
      });

      let faultRunId: string | null = null;
      let injected = false;
      let thresholdLogsAtAfterCommit: number | null = null;
      const heartbeat = heartbeatService(db, {
        runtimeAccountingFaultInjector: async ({ runId, phase }) => {
          if (runId !== faultRunId || phase !== faultPhase || injected) return;
          if (phase === "after_commit") {
            thresholdLogsAtAfterCommit = await db
              .select({ id: activityLog.id })
              .from(activityLog)
              .where(and(
                eq(activityLog.companyId, companyId),
                eq(activityLog.action, "budget.soft_threshold_crossed"),
              ))
              .then((rows) => rows.length);
          }
          injected = true;
          throw new Error(`simulated runtime accounting ${phase} failure`);
        },
      });
      const queued = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "system",
        reason: `runtime_accounting_${faultPhase}`,
      });
      expect(queued).toBeTruthy();
      faultRunId = queued!.id;
      await adapterStartedPromise;
      finishAdapter();

      const terminal = await waitForTerminalRun(heartbeat, queued!.id, 10_000);
      const accountingSettled = await waitForCondition(async () => {
        const [run, runtimeState, event, thresholdLog, currentAgent] = await Promise.all([
          db
            .select({ runtimeAccountedAt: heartbeatRuns.runtimeAccountedAt })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, queued!.id))
            .then((rows) => rows[0] ?? null),
          db
            .select({ lastRunId: agentRuntimeState.lastRunId })
            .from(agentRuntimeState)
            .where(eq(agentRuntimeState.agentId, agentId))
            .then((rows) => rows[0] ?? null),
          db
            .select({ id: costEvents.id })
            .from(costEvents)
            .where(eq(costEvents.heartbeatRunId, queued!.id))
            .then((rows) => rows[0] ?? null),
          db
            .select({ id: activityLog.id })
            .from(activityLog)
            .where(and(
              eq(activityLog.companyId, companyId),
              eq(activityLog.action, "budget.soft_threshold_crossed"),
            ))
            .then((rows) => rows[0] ?? null),
          db
            .select({ status: agents.status })
            .from(agents)
            .where(eq(agents.id, agentId))
            .then((rows) => rows[0] ?? null),
        ]);
        return Boolean(run?.runtimeAccountedAt) &&
          runtimeState?.lastRunId === queued!.id &&
          Boolean(event) &&
          Boolean(thresholdLog) &&
          currentAgent?.status === "idle";
      }, 10_000);
      expect(accountingSettled).toBe(true);

      const [run, runtimeState, agent, company, events, thresholdLogs] = await Promise.all([
        db
          .select({ runtimeAccountedAt: heartbeatRuns.runtimeAccountedAt })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, queued!.id))
          .then((rows) => rows[0]),
        db
          .select()
          .from(agentRuntimeState)
          .where(eq(agentRuntimeState.agentId, agentId))
          .then((rows) => rows[0]),
        db
          .select({ spentMonthlyCents: agents.spentMonthlyCents })
          .from(agents)
          .where(eq(agents.id, agentId))
          .then((rows) => rows[0]),
        db
          .select({ spentMonthlyCents: companies.spentMonthlyCents })
          .from(companies)
          .where(eq(companies.id, companyId))
          .then((rows) => rows[0]),
        db
          .select()
          .from(costEvents)
          .where(eq(costEvents.heartbeatRunId, queued!.id)),
        db
          .select()
          .from(activityLog)
          .where(and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.action, "budget.soft_threshold_crossed"),
          )),
      ]);

      expect(terminal?.status).toBe("succeeded");
      expect(injected).toBe(true);
      if (faultPhase === "after_commit") {
        expect(thresholdLogsAtAfterCommit).toBe(0);
      }
      expect(run?.runtimeAccountedAt).toBeInstanceOf(Date);
      expect(runtimeState).toMatchObject({
        lastRunId: queued!.id,
        totalInputTokens: 101,
        totalCachedInputTokens: 7,
        totalOutputTokens: 29,
        totalCostCents: 123,
      });
      expect(events).toHaveLength(1);
      expect(thresholdLogs).toHaveLength(1);
      expect(events[0]).toMatchObject({
        heartbeatRunId: queued!.id,
        agentId,
        provider: "test",
        biller: "test-biller",
        billingType: "metered_api",
        model: "test-model",
        inputTokens: 101,
        cachedInputTokens: 7,
        outputTokens: 29,
        costCents: 123,
      });
      expect(agent?.spentMonthlyCents).toBe(123);
      expect(company?.spentMonthlyCents).toBe(123);
    }, 20_000);
  }

  for (const otherWriter of ["heartbeat", "manual cost report"] as const) {
  it(`preserves company spend with a concurrent ${otherWriter}`, async () => {
    const { companyId, agentId } = await seedAgent();
    const secondAgentId = randomUUID();
    await db.insert(agents).values({
      id: secondAgentId,
      companyId,
      name: "Concurrent accounting adapter",
      role: "test",
      status: "idle",
      adapterType: "http",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
      permissions: {},
    });
    mockAdapterExecute.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "test",
      model: "concurrent-cost-model",
      billingType: "metered_api",
      costUsd: 1.23,
      usage: { inputTokens: 101, outputTokens: 29 },
    });
    let firstCostReady!: () => void;
    const firstCostReached = new Promise<void>((resolve) => { firstCostReady = resolve; });
    let secondRuntimeReady!: () => void;
    const secondRuntimeReached = new Promise<void>((resolve) => { secondRuntimeReady = resolve; });
    releaseBlockedFollowUps = secondRuntimeReady;
    let firstRunId: string | null = null;
    const heartbeat = heartbeatService(db, {
      runtimeAccountingFaultInjector: async ({ runId, phase }) => {
        if (phase === "before_transaction" && firstRunId === null) firstRunId = runId;
        if (phase === "after_runtime_state" && runId !== firstRunId) secondRuntimeReady();
        if (phase === "after_cost_event" && runId === firstRunId) {
          firstCostReady();
          await secondRuntimeReached;
          // Give the second transaction time to contend with the first one's
          // uncommitted ledger row and company rollup.
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      },
    });
    const firstRun = await heartbeat.wakeup(agentId, {
      source: "on_demand", triggerDetail: "system", reason: "concurrent_accounting",
    });
    await firstCostReached;
    expect(firstRun).toBeTruthy();
    if (otherWriter === "heartbeat") {
      const secondRun = await heartbeat.wakeup(secondAgentId, {
        source: "on_demand", triggerDetail: "system", reason: "concurrent_accounting",
      });
      expect(secondRun).toBeTruthy();
    } else {
      secondRuntimeReady();
      await costService(db).createEvent(companyId, {
        agentId: secondAgentId,
        provider: "test",
        model: "manual-cost-model",
        billingType: "metered_api",
        costCents: 123,
        occurredAt: new Date(),
      });
    }
    expect(await waitForCondition(async () => {
      const rows = await db.select().from(agents).where(inArray(agents.id, [agentId, secondAgentId]));
      return rows.length === 2 && rows.every((agent) => agent.status === "idle");
    }, 10_000)).toBe(true);
    const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    const events = await db.select().from(costEvents).where(eq(costEvents.companyId, companyId));
    expect(events).toHaveLength(2);
    expect(company.spentMonthlyCents).toBe(246);
    expect(events.reduce((sum, event) => sum + event.costCents, 0)).toBe(246);
  }, 20_000);
  }

  it("continues post-terminal finalization when publishPluginDomainEvent throws", async () => {
    const { agentId } = await seedAgent();
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "terminal persisted",
      provider: "test",
      model: "test-model",
      sessionId: "publication-failure-session",
    });
    const publishSpy = vi
      .spyOn(activityLogService, "publishPluginDomainEvent")
      .mockImplementation((event) => {
        if (event.eventType === "agent.run.finished") {
          throw new Error("simulated post-commit publication failure");
        }
      });
    const heartbeat = heartbeatService(db);

    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "system",
      reason: "publication_failure",
      contextSnapshot: {
        taskKey: "publication-failure-task",
      },
    });
    expect(queued).toBeTruthy();

    const terminal = await waitForTerminalRun(heartbeat, queued!.id, 10_000);
    const postTerminalState = await waitForPostTerminalState(db, agentId, queued!.id, 10_000);
    const [wakeup] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.runId, queued!.id));

    expect(terminal?.status).toBe("succeeded");
    expect(wakeup?.status).toBe("completed");
    expect(postTerminalState.runtimeState?.lastRunId).toBe(queued!.id);
    expect(postTerminalState.sessions.some((session) => session.lastRunId === queued!.id)).toBe(true);
    expect(publishSpy.mock.calls.some(([event]) => event.eventType === "agent.run.finished")).toBe(true);
  }, 20_000);

  it("continues wake, lock promotion, dependency scheduling, runtime, and session finalization across injected step failures", async () => {
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
    const injectedFirstAttemptFailures = new Set<HeartbeatPostTerminalStep>([
      "liveness_classification",
      "wakeup_finalize",
      "issue_execution_release",
      "runtime_state",
      "task_session",
    ]);
    const postTerminalAttempts = new Map<HeartbeatPostTerminalStep, number>();
    let faultRunId: string | null = null;
    const heartbeat = heartbeatService(db, {
      postTerminalStepFaultInjector: ({ runId, step, attempt }) => {
        if (runId !== faultRunId) return;
        postTerminalAttempts.set(step, (postTerminalAttempts.get(step) ?? 0) + 1);
        if (injectedFirstAttemptFailures.has(step) && attempt === 1) {
          throw new Error(`simulated ${step} failure`);
        }
      },
    });

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
    faultRunId = queued!.id;
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
        Boolean(dependentWakeup) &&
        postTerminalAttempts.get("runtime_state") === 2 &&
        postTerminalAttempts.get("task_session") === 2;
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
    expect(postTerminalAttempts.get("liveness_classification")).toBe(1);
    expect(postTerminalAttempts.get("wakeup_finalize")).toBe(2);
    expect(postTerminalAttempts.get("issue_execution_release")).toBe(2);
    expect(postTerminalAttempts.get("runtime_state")).toBe(2);
    expect(postTerminalAttempts.get("task_session")).toBe(2);

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

  for (const crashPhase of ["after_terminal_commit", "after_accounting_commit"] as const) {
    it(`recovers ${crashPhase} with a new service instance and concurrent replayers`, async () => {
      const { companyId, agentId } = await seedAgent();
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Durable terminal recovery ${crashPhase}`,
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
      });
      await db.insert(budgetPolicies).values({
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 100,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: false,
        isActive: true,
      });

      let adapterStarted!: () => void;
      const adapterStartedPromise = new Promise<void>((resolve) => { adapterStarted = resolve; });
      let finishAdapter!: () => void;
      const adapterCanFinish = new Promise<void>((resolve) => { finishAdapter = resolve; });
      mockAdapterExecute.mockImplementationOnce(async () => {
        adapterStarted();
        await adapterCanFinish;
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          provider: "test",
          biller: "test-biller",
          model: "durable-recovery-model",
          billingType: "metered_api",
          costUsd: 1.23,
          usage: { inputTokens: 101, cachedInputTokens: 7, outputTokens: 29 },
          sessionId: `durable-session-${crashPhase}`,
        };
      });

      let crashRunId: string | null = null;
      const crashedService = heartbeatService(db, {
        deferTerminalFinalization: ({ runId, phase }) => runId === crashRunId && phase === crashPhase,
      });
      const queued = await crashedService.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        contextSnapshot: { issueId, taskKey: `issue:${issueId}`, wakeReason: "issue_assigned" },
      });
      expect(queued).toBeTruthy();
      crashRunId = queued!.id;
      await adapterStartedPromise;
      await db.update(issues).set({
        status: "done",
        completedAt: new Date(),
        checkoutRunId: queued!.id,
        executionRunId: queued!.id,
        updatedAt: new Date(),
      }).where(eq(issues.id, issueId));
      finishAdapter();

      let crashedRun = await waitForTerminalRun(crashedService, queued!.id, 10_000);
      if (crashPhase === "after_accounting_commit") {
        expect(await waitForCondition(async () => {
          crashedRun = await crashedService.getRun(queued!.id);
          return Boolean(crashedRun?.runtimeAccountedAt) && !crashedRun?.budgetEnforcedAt;
        }, 10_000)).toBe(true);
      }
      expect(crashedRun?.status).toBe("succeeded");
      expect(crashedRun?.terminalFinalizationJson).toBeTruthy();
      expect(crashedRun?.terminalFinalizedAt).toBeNull();
      if (crashPhase === "after_terminal_commit") {
        expect(crashedRun?.runtimeAccountedAt).toBeNull();
        await db.delete(agentTaskSessions).where(eq(agentTaskSessions.agentId, agentId));
        await db.delete(agentRuntimeState).where(eq(agentRuntimeState.agentId, agentId));
      } else {
        expect(crashedRun?.runtimeAccountedAt).toBeInstanceOf(Date);
        expect(crashedRun?.budgetEnforcedAt).toBeNull();
      }

      const firstRestart = heartbeatService(db);
      const secondRestart = heartbeatService(db);
      await Promise.all([
        firstRestart.reconcileTerminalRuns(),
        secondRestart.reconcileTerminalRuns(),
      ]);
      const replay = await heartbeatService(db).reconcileTerminalRuns();
      expect(replay).toEqual({ completed: 0, pending: 0 });

      const [run, runtimeState, currentAgent, sourceIssue, wakeups, events, incidents, approvalsRows, hardLogs, sessions] =
        await Promise.all([
          db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id)).then((rows) => rows[0]),
          db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, agentId)).then((rows) => rows[0]),
          db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]),
          db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]),
          db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, queued!.id)),
          db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, queued!.id)),
          db.select().from(budgetIncidents).where(and(
            eq(budgetIncidents.companyId, companyId),
            eq(budgetIncidents.thresholdType, "hard"),
          )),
          db.select().from(approvals).where(and(
            eq(approvals.companyId, companyId),
            eq(approvals.type, "budget_override_required"),
          )),
          db.select().from(activityLog).where(and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.action, "budget.hard_threshold_crossed"),
          )),
          db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, agentId)),
        ]);

      expect(run.runtimeAccountedAt).toBeInstanceOf(Date);
      expect(run.budgetEnforcedAt).toBeInstanceOf(Date);
      expect(run.terminalFinalizedAt).toBeInstanceOf(Date);
      expect(run.terminalFinalizationJson).toMatchObject({
        version: 1,
        completed: {
          wakeup: true,
          runtime: true,
          taskSession: true,
          agent: true,
          issueExecution: true,
        },
      });
      expect(runtimeState).toMatchObject({
        totalInputTokens: 101,
        totalCachedInputTokens: 7,
        totalOutputTokens: 29,
        totalCostCents: 123,
        lastRunId: queued!.id,
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ costCents: 123, inputTokens: 101, outputTokens: 29 });
      expect(incidents).toHaveLength(1);
      expect(approvalsRows).toHaveLength(1);
      expect(hardLogs).toHaveLength(1);
      expect(currentAgent.status).toBe("paused");
      expect(wakeups).toHaveLength(1);
      expect(wakeups[0]?.status).toBe("completed");
      expect(sourceIssue.checkoutRunId).toBeNull();
      expect(sourceIssue.executionRunId).toBeNull();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.lastRunId).toBe(queued!.id);
    }, 30_000);
  }

  it("accounts an old pending run without rewinding a newer run or reset sessions", async () => {
    const { companyId, agentId } = await seedAgent();
    const oldRunId = randomUUID();
    const newerRunId = randomUUID();
    const oldStartedAt = new Date("2026-08-31T23:58:00.000Z");
    const newerStartedAt = new Date("2026-09-01T00:02:00.000Z");
    const now = new Date("2026-09-01T00:03:00.000Z");

    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 25,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
    });
    await db.insert(heartbeatRuns).values([
      {
        id: oldRunId,
        companyId,
        agentId,
        status: "succeeded",
        createdAt: oldStartedAt,
        startedAt: oldStartedAt,
        finishedAt: new Date("2026-08-31T23:59:00.000Z"),
        terminalFinalizationJson: {
          version: 1,
          adapterType: "claude_local",
          ledger: {
            usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 },
            costUsd: 0.25,
            provider: "test",
            biller: "test-biller",
            billingType: "metered_api",
            model: "old-model",
          },
          session: {
            generation: 0,
            taskGeneration: 0,
            legacySessionId: "old-global-session",
            taskKey: "issue:reset-task",
            mode: "upsert",
            params: { sessionId: "old-task-session" },
            displayId: "old-task-session",
          },
          completed: {},
        },
      },
      {
        id: newerRunId,
        companyId,
        agentId,
        status: "succeeded",
        createdAt: newerStartedAt,
        startedAt: newerStartedAt,
        finishedAt: now,
        runtimeAccountedAt: now,
        budgetEnforcedAt: now,
        terminalFinalizedAt: now,
      },
    ]);
    await db.insert(agentRuntimeState).values({
      companyId,
      agentId,
      adapterType: "claude_local",
      sessionId: "new-global-session",
      sessionGeneration: 1,
      lastRunId: newerRunId,
      lastRunStatus: "succeeded",
      totalInputTokens: 20,
      totalCachedInputTokens: 4,
      totalOutputTokens: 6,
      totalCostCents: 50,
    });
    await db.insert(agentTaskSessions).values([
      {
        companyId,
        agentId,
        adapterType: "claude_local",
        taskKey: "issue:reset-task",
        sessionGeneration: 1,
        sessionParamsJson: null,
        sessionDisplayId: null,
        lastRunId: newerRunId,
      },
      {
        companyId,
        agentId,
        adapterType: "claude_local",
        taskKey: "issue:unrelated-task",
        sessionGeneration: 4,
        sessionParamsJson: { sessionId: "unrelated-session" },
        sessionDisplayId: "unrelated-session",
        lastRunId: newerRunId,
      },
    ]);
    await db.insert(costEvents).values({
      companyId,
      agentId,
      heartbeatRunId: newerRunId,
      provider: "test",
      biller: "test-biller",
      billingType: "metered_api",
      model: "new-model",
      inputTokens: 20,
      cachedInputTokens: 4,
      outputTokens: 6,
      costCents: 50,
      occurredAt: now,
    });

    const firstRestart = heartbeatService(db);
    expect(await firstRestart.reconcileTerminalRuns()).toEqual({ completed: 1, pending: 0 });
    expect(await heartbeatService(db).reconcileTerminalRuns()).toEqual({ completed: 0, pending: 0 });

    const [oldRun, runtime, taskSessions, events, incidents] = await Promise.all([
      firstRestart.getRun(oldRunId),
      db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, agentId)).then((rows) => rows[0]),
      db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, agentId)),
      db.select().from(costEvents).where(eq(costEvents.agentId, agentId)),
      db.select().from(budgetIncidents).where(and(
        eq(budgetIncidents.companyId, companyId),
        eq(budgetIncidents.thresholdType, "hard"),
      )),
    ]);
    const resetTask = taskSessions.find((session) => session.taskKey === "issue:reset-task");
    const unrelatedTask = taskSessions.find((session) => session.taskKey === "issue:unrelated-task");

    expect(oldRun?.terminalFinalizedAt).toBeInstanceOf(Date);
    expect(runtime).toMatchObject({
      sessionId: "new-global-session",
      sessionGeneration: 1,
      lastRunId: newerRunId,
      lastRunStatus: "succeeded",
      totalInputTokens: 30,
      totalCachedInputTokens: 6,
      totalOutputTokens: 9,
      totalCostCents: 75,
    });
    expect(resetTask).toMatchObject({
      sessionGeneration: 1,
      sessionParamsJson: null,
      sessionDisplayId: null,
      lastRunId: newerRunId,
    });
    expect(unrelatedTask).toMatchObject({
      sessionGeneration: 4,
      sessionParamsJson: { sessionId: "unrelated-session" },
      sessionDisplayId: "unrelated-session",
      lastRunId: newerRunId,
    });
    expect(events).toHaveLength(2);
    expect(events.filter((event) => event.heartbeatRunId === oldRunId)).toHaveLength(1);
    expect(events.reduce((sum, event) => sum + event.costCents, 0)).toBe(75);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      amountObserved: 25,
      windowStart: new Date("2026-08-01T00:00:00.000Z"),
      windowEnd: new Date("2026-09-01T00:00:00.000Z"),
    });
  }, 30_000);

  it("clears only an old checkout and leaves post-boundary deferred work behind a newer execution", async () => {
    const { companyId, agentId } = await seedAgent();
    const oldRunId = randomUUID();
    const newerRunId = randomUUID();
    const issueId = randomUUID();
    const lateWakeId = randomUUID();
    const oldStartedAt = new Date("2026-09-10T10:00:00.000Z");
    const oldFinishedAt = new Date("2026-09-10T10:01:00.000Z");
    const newerStartedAt = new Date("2026-09-10T10:02:00.000Z");

    await db.insert(heartbeatRuns).values([
      {
        id: oldRunId,
        companyId,
        agentId,
        status: "succeeded",
        createdAt: oldStartedAt,
        startedAt: oldStartedAt,
        finishedAt: oldFinishedAt,
        contextSnapshot: { issueId, taskKey: `issue:${issueId}` },
        terminalFinalizationJson: {
          version: 1,
          adapterType: null,
          ledger: null,
          session: null,
          completed: {},
        },
      },
      {
        id: newerRunId,
        companyId,
        agentId,
        status: "succeeded",
        createdAt: newerStartedAt,
        startedAt: newerStartedAt,
        finishedAt: new Date("2026-09-10T10:03:00.000Z"),
        terminalFinalizedAt: new Date("2026-09-10T10:03:01.000Z"),
        contextSnapshot: { issueId, taskKey: `issue:${issueId}` },
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Preserve the newer execution lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: oldRunId,
      executionRunId: newerRunId,
      executionAgentNameKey: "persistencetestadaptor",
      executionLockedAt: newerStartedAt,
    });
    await db.insert(agentWakeupRequests).values({
      id: lateWakeId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: { issueId },
      status: "deferred_issue_execution",
      requestedAt: new Date("2026-09-10T10:01:01.000Z"),
    });

    expect(await heartbeatService(db).reconcileTerminalRuns()).toEqual({ completed: 1, pending: 0 });
    const [oldRun, issue, lateWake] = await Promise.all([
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, oldRunId)).then((rows) => rows[0]),
      db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]),
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, lateWakeId)).then((rows) => rows[0]),
    ]);

    expect(oldRun.terminalFinalizedAt).toBeInstanceOf(Date);
    expect(issue.checkoutRunId).toBeNull();
    expect(issue.executionRunId).toBe(newerRunId);
    expect(issue.executionAgentNameKey).toBe("persistencetestadaptor");
    expect(issue.executionLockedAt).toEqual(newerStartedAt);
    expect(lateWake).toMatchObject({ status: "deferred_issue_execution", runId: null });
  }, 30_000);

  it("distinguishes zero, subscription, unknown, and legacy accounting", async () => {
    const cases = [
      {
        name: "known zero",
        result: {
          exitCode: 0,
          signal: null,
          timedOut: false,
          billingType: "metered_api",
          costUsd: 0,
          usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
        },
        expected: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costCents: 0, events: 0 },
      },
      {
        name: "subscription usage",
        result: {
          exitCode: 0,
          signal: null,
          timedOut: false,
          billingType: "subscription",
          costUsd: 999,
          usage: { inputTokens: 12, cachedInputTokens: 3, outputTokens: 4 },
        },
        expected: { inputTokens: 12, cachedInputTokens: 3, outputTokens: 4, costCents: 0, events: 1 },
      },
      {
        name: "unknown usage",
        result: { exitCode: 0, signal: null, timedOut: false },
        expected: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costCents: 0, events: 0 },
      },
    ] as const;

    for (const accountingCase of cases) {
      const { agentId } = await seedAgent();
      mockAdapterExecute.mockResolvedValueOnce(accountingCase.result);
      const heartbeat = heartbeatService(db);
      const queued = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "system",
        reason: `accounting_${accountingCase.name.replaceAll(" ", "_")}`,
      });
      expect(queued).toBeTruthy();
      expect((await waitForTerminalRun(heartbeat, queued!.id, 10_000))?.status).toBe("succeeded");
      await heartbeatService(db).reconcileTerminalRuns();
      const finalized = await waitForCondition(async () =>
        Boolean((await heartbeat.getRun(queued!.id))?.terminalFinalizedAt), 10_000
      );
      const finalRun = await heartbeat.getRun(queued!.id);
      expect(finalized, `${accountingCase.name}: ${JSON.stringify({
        runtimeAccountedAt: finalRun?.runtimeAccountedAt,
        budgetEnforcedAt: finalRun?.budgetEnforcedAt,
        terminalFinalizationJson: finalRun?.terminalFinalizationJson,
      })}`).toBe(true);

      const [runtime, events] = await Promise.all([
        db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, agentId)).then((rows) => rows[0]),
        db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, queued!.id)),
      ]);
      expect(runtime).toMatchObject({
        totalInputTokens: accountingCase.expected.inputTokens,
        totalCachedInputTokens: accountingCase.expected.cachedInputTokens,
        totalOutputTokens: accountingCase.expected.outputTokens,
        totalCostCents: accountingCase.expected.costCents,
      });
      expect(events).toHaveLength(accountingCase.expected.events);
      if (accountingCase.name === "subscription usage") {
        expect(events[0]).toMatchObject({
          billingType: "subscription_included",
          inputTokens: 12,
          cachedInputTokens: 3,
          outputTokens: 4,
          costCents: 0,
        });
      }
    }

    const { companyId, agentId } = await seedAgent();
    const legacyRunId = randomUUID();
    const occurredAt = new Date("2026-08-15T12:00:00.000Z");
    await db.insert(heartbeatRuns).values({
      id: legacyRunId,
      companyId,
      agentId,
      status: "succeeded",
      startedAt: occurredAt,
      finishedAt: occurredAt,
      terminalFinalizationJson: null,
    });
    await db.insert(agentRuntimeState).values({
      companyId,
      agentId,
      adapterType: "http",
      lastRunId: legacyRunId,
      lastRunStatus: "succeeded",
      totalCostCents: 40,
    });
    await db.insert(costEvents).values({
      companyId,
      agentId,
      heartbeatRunId: legacyRunId,
      provider: "legacy",
      biller: "legacy",
      billingType: "metered_api",
      model: "legacy-model",
      costCents: 40,
      occurredAt,
    });

    expect(await heartbeatService(db).reconcileTerminalRuns()).toEqual({ completed: 0, pending: 0 });
    const [legacyRun, legacyRuntime, legacyEvents] = await Promise.all([
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, legacyRunId)).then((rows) => rows[0]),
      db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, agentId)).then((rows) => rows[0]),
      db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, legacyRunId)),
    ]);
    expect(legacyRun.runtimeAccountedAt).toBeNull();
    expect(legacyRuntime.totalCostCents).toBe(40);
    expect(legacyEvents).toHaveLength(1);
  }, 30_000);

  it("rejects unpersistable adapter usage and cost before terminal success", async () => {
    for (const invalidResult of [
      {
        exitCode: 0,
        signal: null,
        timedOut: false,
        usage: { inputTokens: 2_147_483_648, cachedInputTokens: 0, outputTokens: 0 },
      },
      {
        exitCode: 0,
        signal: null,
        timedOut: false,
        costUsd: Number.MAX_VALUE,
      },
    ]) {
      const { agentId } = await seedAgent();
      mockAdapterExecute.mockResolvedValueOnce(invalidResult);
      const heartbeat = heartbeatService(db);
      const queued = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "system",
        reason: "invalid_ledger_contract",
      });
      expect(queued).toBeTruthy();
      const terminal = await waitForTerminalRun(heartbeat, queued!.id, 10_000);
      expect(terminal?.status).toBe("failed");
      expect(terminal?.error).toContain("PostgreSQL int4");
      expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, queued!.id))).toHaveLength(0);
      expect(await waitForCondition(async () => {
        const [run, agent] = await Promise.all([
          heartbeat.getRun(queued!.id),
          db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]),
        ]);
        return Boolean(run?.terminalFinalizedAt) && agent?.status !== "running";
      }, 10_000)).toBe(true);
    }
  }, 30_000);

  it("rotates 101 poison terminal rows so a valid pending row is reconciled", async () => {
    const { companyId, agentId } = await seedAgent();
    const poisonIds = Array.from({ length: 101 }, (_, index) =>
      `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`
    );
    const validId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await db.insert(heartbeatRuns).values([
      ...poisonIds.map((id) => ({
        id,
        companyId,
        agentId,
        status: "failed",
        finishedAt: new Date(),
        terminalFinalizationJson: { version: 1, completed: { wakeup: "not-a-boolean" } },
      })),
      {
        id: validId,
        companyId,
        agentId,
        status: "failed",
        finishedAt: new Date(),
        terminalFinalizationJson: {
          version: 1,
          adapterType: null,
          ledger: null,
          session: null,
          completed: {},
        },
      },
    ]);
    const warningSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.reconcileTerminalRuns({ limit: 100 });
    expect(first).toEqual({ completed: 0, pending: 100 });
    expect((await heartbeat.getRun(validId))?.terminalFinalizedAt).toBeNull();
    const second = await heartbeat.reconcileTerminalRuns({ limit: 100 });
    expect(second.completed).toBe(1);
    expect((await heartbeat.getRun(validId))?.terminalFinalizedAt).toBeInstanceOf(Date);
    expect(warningSpy.mock.calls.some(([, message]) =>
      message === "invalid or unsupported durable terminal finalization payload; recovery remains pending"
    )).toBe(true);
  }, 30_000);
});
