import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  normalizeAdapterExecutionResultForPersistence,
  sanitizeHeartbeatPersistenceRecord,
  sanitizeHeartbeatPersistenceText,
} from "./heartbeat-persistence-safety.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping heartbeat persistence safety PostgreSQL tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat persistence safety with PostgreSQL", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-safety-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Heartbeat persistence safety",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SafetyAdapter",
      role: "test",
      status: "idle",
      adapterType: "http",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("demonstrates PostgreSQL rejection before the boundary and success after sanitization", async () => {
    await expect(db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "succeeded",
      contextSnapshot: { unsafe: "context\u0000value" },
    })).rejects.toThrow();

    const runId = randomUUID();
    const adapterResult = normalizeAdapterExecutionResultForPersistence({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "summary\u0000value",
      resultJson: { "result\u0000key": ["result\u0000value"] },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
      finishedAt: new Date(),
      contextSnapshot: sanitizeHeartbeatPersistenceRecord({
        "context\u0000key": "context\u0000value",
      }),
      resultJson: sanitizeHeartbeatPersistenceRecord(adapterResult),
      stdoutExcerpt: sanitizeHeartbeatPersistenceText("stdout\u0000value"),
      stderrExcerpt: sanitizeHeartbeatPersistenceText("stderr\u0000value"),
    });

    const persisted = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    const encoded = JSON.stringify(persisted);
    expect(encoded).not.toContain("\u0000");
    expect(encoded).toContain("\uFFFD");
    expect(persisted?.resultJson).toMatchObject({
      summary: "summary\uFFFDvalue",
      resultJson: { "result\uFFFDkey": ["result\uFFFDvalue"] },
    });
  });
});
