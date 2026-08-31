import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateExternalTestDatabaseUrl } from "./test-embedded-postgres.js";

const inducedTimeoutDataDirs = new Set<string>();

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("embedded-postgres");
  vi.doUnmock("./embedded-postgres-native.js");
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
    "https://localhost/paperclip_test",
    "not a URL",
  ])("fails closed for a non-exclusive destination: %s", (url) => {
    expect(() => validateExternalTestDatabaseUrl(url)).toThrow();
  });

  it.each([
    "postgres://paperclip:secret@127.0.0.1/paperclip_test",
    "postgresql://paperclip:secret@127.0.0.1/paperclip-ci",
    "postgres://paperclip:secret@127.0.0.1/test",
    "postgres://paperclip:secret@127.0.0.1/ephemeral_paperclip",
    "postgres://paperclip:secret@[::1]/paperclip_testing",
  ])("accepts an unmistakable test control database: %s", (url) => {
    expect(validateExternalTestDatabaseUrl(url)).toBeInstanceOf(URL);
  });

  it("rejects a remote hostname even when the test runner tries to allow it", () => {
    vi.stubEnv("PAPERCLIP_TEST_DATABASE_ALLOWED_HOSTS", "db.production.internal");

    expect(() =>
      validateExternalTestDatabaseUrl(
        "postgres://paperclip:secret@db.production.internal/paperclip_test",
      ),
    ).toThrow(/numeric loopback host/);
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
