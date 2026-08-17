import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  companyMemberships,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue NUL body route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue persisted body NUL sanitization", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: ReturnType<typeof createApp>;
  let companyId!: string;
  let issueId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-nul-body-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "NUL body test tenant",
      issuePrefix: "NUL",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "NUL-1",
      title: "Persist text bodies safely",
      status: "todo",
      priority: "high",
    });

    app = createApp(companyId);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createStorage(): StorageService {
    return {
      provider: "local_disk",
      putFile: vi.fn(async () => {
        throw new Error("Unexpected storage.putFile call in NUL body route test");
      }),
      getObject: vi.fn(async () => {
        throw new Error("Unexpected storage.getObject call in NUL body route test");
      }),
      headObject: vi.fn(async () => ({ exists: false })),
      deleteObject: vi.fn(async () => undefined),
    };
  }

  function createApp(companyIdForActor: string) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "board-user-1",
        companyIds: [companyIdForActor],
        memberships: [{ companyId: companyIdForActor, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    testApp.use("/api", issueRoutes(db, createStorage()));
    testApp.use(errorHandler);
    return testApp;
  }

  it("strips NUL from comments and their activity details while preserving ordinary comments", async () => {
    const nulComment = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "probe NUL:\u0000 fin" });

    expect(nulComment.status, JSON.stringify(nulComment.body)).toBe(201);
    expect(nulComment.body.body).toBe("probe NUL: fin");

    const controlComment = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "control without NUL" });

    expect(controlComment.status, JSON.stringify(controlComment.body)).toBe(201);
    expect(controlComment.body.body).toBe("control without NUL");

    const comments = await request(app)
      .get(`/api/issues/${issueId}/comments`)
      .query({ order: "asc" });
    expect(comments.status, JSON.stringify(comments.body)).toBe(200);
    expect(comments.body.map((comment: { body: string }) => comment.body)).toEqual([
      "probe NUL: fin",
      "control without NUL",
    ]);

    const activities = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.comment_added"));
    expect(activities).toEqual(expect.arrayContaining([
      { details: expect.objectContaining({ bodySnippet: "probe NUL: fin" }) },
    ]));
    expect(JSON.stringify(activities)).not.toContain("\u0000");
  });

  it("strips NUL from issue documents before persisting them", async () => {
    const document = await request(app)
      .put(`/api/issues/${issueId}/documents/qa-notes`)
      .send({
        title: "NUL regression",
        format: "markdown",
        body: "# Regr\u0000ession\n\nBody remains readable.\u0000",
      });

    expect(document.status, JSON.stringify(document.body)).toBe(201);
    expect(document.body.body).toBe("# Regression\n\nBody remains readable.");

    const persisted = await request(app).get(`/api/issues/${issueId}/documents/qa-notes`);
    expect(persisted.status, JSON.stringify(persisted.body)).toBe(200);
    expect(persisted.body.body).toBe("# Regression\n\nBody remains readable.");
  });
});
