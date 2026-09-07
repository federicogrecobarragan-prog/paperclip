import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, approvals, budgetIncidents, budgetPolicies, companies,
  costEvents, createDb,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { budgetService } from "../services/budgets.ts";
import * as activityLogService from "../services/activity-log.ts";
import * as liveEventsService from "../services/live-events.ts";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping budget accounting PostgreSQL tests: ${support.reason}`);

describePostgres("atomic budget incidents and recoverable enforcement", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budget-accounting-");
    db = createDb(tempDb.connectionString);
  }, 90_000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await tempDb?.cleanup();
  }, 20_000);

  async function seedExceededBudget() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Budget transaction test",
      issuePrefix: `B${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Budget agent", role: "test", status: "idle",
      adapterType: "http", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(budgetPolicies).values({
      companyId, scopeType: "agent", scopeId: agentId, metric: "billed_cents",
      windowKind: "calendar_month_utc", amount: 100, warnPercent: 80,
      hardStopEnabled: true, notifyEnabled: false, isActive: true,
    });
    const [event] = await db.insert(costEvents).values({
      companyId, agentId, provider: "test", model: "test", billingType: "metered_api",
      costCents: 123, occurredAt: new Date(),
    }).returning();
    return { companyId, agentId, event };
  }

  async function records(companyId: string) {
    const [incidents, approvalRows, logs] = await Promise.all([
      db.select().from(budgetIncidents).where(eq(budgetIncidents.companyId, companyId)),
      db.select().from(approvals).where(eq(approvals.companyId, companyId)),
      db.select().from(activityLog).where(eq(activityLog.companyId, companyId)),
    ]);
    return { incidents, approvals: approvalRows, logs };
  }

  it("rolls back approval and incident when threshold audit fails, then retries once", async () => {
    const { companyId, event } = await seedExceededBudget();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    const originalLogActivity = activityLogService.logActivity;
    const publishSpy = vi.spyOn(liveEventsService, "publishLiveEvent");
    vi.spyOn(activityLogService, "logActivity").mockImplementationOnce(async (...args) => {
      await originalLogActivity(...args);
      throw new Error("audit insert failed");
    });
    await expect(service.evaluateCostEvent(event)).rejects.toThrow("audit insert failed");
    expect(await records(companyId)).toEqual({ incidents: [], approvals: [], logs: [] });
    expect(cancelWorkForScope).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
    await service.evaluateCostEvent(event);
    const persisted = await records(companyId);
    expect(persisted.incidents).toHaveLength(1);
    expect(persisted.approvals).toHaveLength(1);
    expect(persisted.logs).toHaveLength(1);
    expect(persisted.logs[0].action).toBe("budget.hard_threshold_crossed");
    expect(cancelWorkForScope).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the threshold audit and retries cancellation after its hook fails", async () => {
    const { companyId, event } = await seedExceededBudget();
    const cancelWorkForScope = vi.fn()
      .mockRejectedValueOnce(new Error("cancellation failed"))
      .mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    await expect(service.evaluateCostEvent(event)).rejects.toThrow("cancellation failed");
    expect((await records(companyId)).logs).toHaveLength(1);
    await service.evaluateCostEvent(event);
    const persisted = await records(companyId);
    expect(persisted.incidents).toHaveLength(1);
    expect(persisted.approvals).toHaveLength(1);
    expect(persisted.logs).toHaveLength(1);
    expect(cancelWorkForScope).toHaveBeenCalledTimes(2);
  });

  it("creates one approval, incident, and audit under concurrent evaluations", async () => {
    const { companyId, event } = await seedExceededBudget();
    const service = budgetService(db);
    await Promise.all(Array.from({ length: 4 }, () => service.evaluateCostEvent(event)));
    const persisted = await records(companyId);
    expect(persisted.incidents).toHaveLength(1);
    expect(persisted.approvals).toHaveLength(1);
    expect(persisted.logs).toHaveLength(1);
    expect(persisted.incidents[0].approvalId).toBe(persisted.approvals[0].id);
  });
});
