import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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

describeEmbeddedPostgres("heartbeat U+0000 PostgreSQL persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-nul-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
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
      runtimeConfig: {},
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

  it("keeps a persisted terminal outcome authoritative when a later publication throws", async () => {
    const { agentId } = await seedAgent();
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "terminal persisted",
      provider: "test",
      model: "test-model",
    });
    vi.spyOn(activityLogService, "publishPluginDomainEvent").mockImplementation((event) => {
      if (event.eventType === "agent.run.finished") throw new Error("simulated post-commit publication failure");
    });
    const heartbeat = heartbeatService(db);

    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "system",
    });
    expect(queued).toBeTruthy();
    const terminal = await waitForTerminalRun(heartbeat, queued!.id);
    await heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 });
    const reconciled = await heartbeat.getRun(queued!.id);

    expect(terminal?.status).toBe("succeeded");
    expect(reconciled?.status).toBe("succeeded");
    expect(reconciled?.errorCode).not.toBe("process_lost");
  });
});
