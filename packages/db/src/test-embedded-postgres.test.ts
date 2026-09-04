import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatExternalTestDatabaseMutationAudit,
  validateExternalTestDatabaseHostedRuntime,
  validateExternalTestDatabaseRuntimeEvidence,
  validateExternalTestDatabaseUrl,
  type ExternalTestDatabaseRuntimeEvidence,
} from "./test-embedded-postgres.js";

const inducedTimeoutDataDirs = new Set<string>();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("embedded-postgres");
  vi.doUnmock("./embedded-postgres-native.js");
  vi.doUnmock("./client.js");
  vi.doUnmock("postgres");
  vi.resetModules();
  for (const dataDir of inducedTimeoutDataDirs) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  inducedTimeoutDataDirs.clear();
});

describe("external PostgreSQL test database safety", () => {
  it.each([
    "postgres://paperclip:secret@localhost/paperclip",
    "postgres://paperclip:secret@localhost/production",
    "postgres://paperclip:secret@localhost/contest",
    "postgres://paperclip:secret@localhost/paperclip_test",
    "postgres://paperclip:secret@localhost/paperclip_test%2Fproduction",
    "postgres://paperclip:secret@db.production.internal/paperclip_test",
    "postgres://paperclip:secret@localhost.example.com/paperclip_test",
    "postgres://paperclip:secret@127.0.0.1/paperclip_test",
    "postgres://paperclip:secret@127.0.0.1:5433/paperclip_test",
    "postgres://paperclip:secret@[::1]:5432/paperclip_test",
    "postgres://paperclip:secret@127.0.0.1:5432/test",
    "postgres://postgres:secret@127.0.0.1:5432/paperclip_test",
    "postgres://paperclip@127.0.0.1:5432/paperclip_test",
    "postgres://paperclip:secret@127.0.0.1:5432/paperclip_test?sslmode=disable",
    "https://localhost/paperclip_test",
    "not a URL",
  ])("fails closed for a non-exclusive destination: %s", (url) => {
    expect(() => validateExternalTestDatabaseUrl(url)).toThrow();
  });

  it.each([
    "postgres://paperclip:secret@127.0.0.1:5432/paperclip_test",
    "postgresql://paperclip:secret@127.0.0.1:5432/paperclip_test",
  ])("accepts only the exact disposable CI service endpoint: %s", (url) => {
    expect(validateExternalTestDatabaseUrl(url)).toBeInstanceOf(URL);
  });

  it("rejects a remote hostname even when the test runner tries to allow it", () => {
    vi.stubEnv("PAPERCLIP_TEST_DATABASE_ALLOWED_HOSTS", "db.production.internal");

    expect(() =>
      validateExternalTestDatabaseUrl(
        "postgres://paperclip:secret@db.production.internal/paperclip_test",
      ),
    ).toThrow(/127\.0\.0\.1/);
  });

  it("requires the non-overridable GitHub-hosted runtime identity", () => {
    expect(() => validateExternalTestDatabaseHostedRuntime({
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "github-hosted",
      GITHUB_SERVER_URL: "https://github.com",
    })).not.toThrow();

    for (const env of [
      {},
      { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted", GITHUB_SERVER_URL: "https://github.com" },
      { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", GITHUB_SERVER_URL: "https://example.com" },
    ]) {
      expect(() => validateExternalTestDatabaseHostedRuntime(env)).toThrow(/github-hosted/);
    }
  });

  it("accepts only a fresh, empty postgres:16 service with the exact disposable topology", () => {
    const evidence: ExternalTestDatabaseRuntimeEvidence = {
      currentDatabase: "paperclip_test",
      currentUser: "paperclip",
      serverVersionNum: 160_012,
      dataDirectory: "/var/lib/postgresql/data",
      postmasterAgeSeconds: 30,
      inRecovery: false,
      userDatabaseNames: ["postgres", "paperclip_test"],
      loginRoleNames: ["paperclip"],
      userRelationCount: 0,
    };

    expect(() => validateExternalTestDatabaseRuntimeEvidence(evidence, null)).not.toThrow();
    expect(() => validateExternalTestDatabaseRuntimeEvidence({
      ...evidence,
      userDatabaseNames: ["postgres", "paperclip_test", "production"],
    }, null)).toThrow(/fail-closed disposable/);
    expect(() => validateExternalTestDatabaseRuntimeEvidence({
      ...evidence,
      userRelationCount: 1,
    }, null)).toThrow(/fail-closed disposable/);
    expect(() => validateExternalTestDatabaseRuntimeEvidence({
      ...evidence,
      postmasterAgeSeconds: 10_000,
    }, null)).toThrow(/fail-closed disposable/);
    expect(() => validateExternalTestDatabaseRuntimeEvidence({
      ...evidence,
      serverVersionNum: 150_999,
    }, null)).toThrow(/fail-closed disposable/);

    const lease = "paperclip_test_0123456789abcdef0123456789abcdef";
    expect(() => validateExternalTestDatabaseRuntimeEvidence({
      ...evidence,
      userDatabaseNames: ["postgres", "paperclip_test", lease],
    }, lease)).not.toThrow();
    expect(() => validateExternalTestDatabaseRuntimeEvidence(evidence, "paperclip_test_manual"))
      .toThrow(/not generated/);
  });

  it("formats a visible mutation exception without rendering credentials", () => {
    const secret = "audit-secret-password";
    const audit = formatExternalTestDatabaseMutationAudit({
      action: "create",
      targetDatabaseName: "paperclip_test_0123456789abcdef0123456789abcdef",
    });

    expect(audit).toContain("action=create");
    expect(audit).toContain("attestation=github-hosted+postgres16-disposable");
    expect(audit).not.toContain(secret);
    expect(audit).not.toContain("password");
    expect(() => formatExternalTestDatabaseMutationAudit({
      action: "drop",
      targetDatabaseName: `paperclip_test_${secret}`,
    })).toThrow(/not generated/);
  });

  it("attests and audits before every external CREATE, migration, and DROP", async () => {
    vi.resetModules();
    const secret = "ordering-test-secret";
    vi.stubEnv(
      "PAPERCLIP_TEST_DATABASE_URL",
      `postgres://paperclip:${secret}@127.0.0.1:5432/paperclip_test`,
    );
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("RUNNER_ENVIRONMENT", "github-hosted");
    vi.stubEnv("GITHUB_SERVER_URL", "https://github.com");

    const events: string[] = [];
    let leaseDatabaseName: string | null = null;
    const sql = Object.assign(
      async (strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("pg_advisory_lock")) return [];
        if (query.includes("current_database()")) {
          return [{
            currentDatabase: "paperclip_test",
            currentUser: "paperclip",
            serverVersionNum: 160_012,
            dataDirectory: "/var/lib/postgresql/data",
            postmasterAgeSeconds: 30,
            inRecovery: false,
          }];
        }
        if (query.includes("WHERE NOT datistemplate")) {
          return ["paperclip_test", "postgres", ...(leaseDatabaseName ? [leaseDatabaseName] : [])]
            .sort()
            .map((name) => ({ name }));
        }
        if (query.includes("FROM pg_roles")) return [{ name: "paperclip" }];
        if (query.includes("FROM pg_class")) return [{ count: 0 }];
        if (query.includes("SELECT EXISTS")) return [{ exists: leaseDatabaseName !== null }];
        throw new Error(`Unexpected SQL in safety-ordering test: ${query}`);
      },
      {
        unsafe: vi.fn(async (query: string) => {
          const createMatch = query.match(/^CREATE DATABASE "([a-z0-9_]+)"$/);
          if (createMatch) {
            events.push("create");
            leaseDatabaseName = createMatch[1]!;
            return;
          }
          if (query.startsWith("DROP DATABASE")) {
            events.push("drop");
            leaseDatabaseName = null;
            return;
          }
          throw new Error(`Unexpected unsafe SQL in safety-ordering test: ${query}`);
        }),
        end: vi.fn(async () => {}),
      },
    );
    vi.doMock("postgres", () => ({ default: () => sql }));
    vi.doMock("./client.js", () => ({
      applyPendingMigrations: vi.fn(async () => {
        events.push("migrate");
      }),
      ensurePostgresDatabase: vi.fn(async () => {}),
    }));
    vi.spyOn(console, "warn").mockImplementation((value: unknown) => {
      const message = String(value);
      const action = message.match(/action=(create|migrate|drop)/)?.[1];
      if (action) events.push(`audit:${action}`);
      expect(message).not.toContain(secret);
    });

    const { startEmbeddedPostgresTestDatabase } = await import("./test-embedded-postgres.js");
    const database = await startEmbeddedPostgresTestDatabase("unused-external-prefix-");
    await database.cleanup();

    expect(events).toEqual([
      "audit:create",
      "create",
      "audit:migrate",
      "migrate",
      "audit:drop",
      "drop",
    ]);
  });
});

describe("embedded PostgreSQL startup lifecycle", () => {
  it.each(["initialise", "start"] as const)(
    "times out a hung %s phase and removes its data directory",
    async (hungPhase) => {
      vi.resetModules();
      vi.stubEnv("PAPERCLIP_EMBEDDED_POSTGRES_STARTUP_TIMEOUT_MS", "25");

      const stop = vi.fn(async () => {});
      vi.doMock("embedded-postgres", () => ({
        default: class MockEmbeddedPostgres {
          constructor(options: { databaseDir: string }) {
            inducedTimeoutDataDirs.add(options.databaseDir);
          }

          initialise(): Promise<void> {
            return hungPhase === "initialise" ? new Promise(() => {}) : Promise.resolve();
          }

          start(): Promise<void> {
            return hungPhase === "start" ? new Promise(() => {}) : Promise.resolve();
          }

          stop(): Promise<void> {
            return stop();
          }
        },
      }));
      vi.doMock("./embedded-postgres-native.js", () => ({
        prepareEmbeddedPostgresNativeRuntime: vi.fn(async () => {}),
      }));

      const { getEmbeddedPostgresTestSupport } = await import("./test-embedded-postgres.js");
      const startedAt = performance.now();
      const support = await getEmbeddedPostgresTestSupport();

      expect(performance.now() - startedAt).toBeLessThan(500);
      expect(support).toEqual({
        supported: false,
        reason: expect.stringContaining(`${hungPhase} timed out`),
      });
      expect(stop).toHaveBeenCalledOnce();
      expect(inducedTimeoutDataDirs.size).toBe(1);
      for (const dataDir of inducedTimeoutDataDirs) {
        expect(fs.existsSync(dataDir)).toBe(false);
      }
    },
    1_000,
  );
});
