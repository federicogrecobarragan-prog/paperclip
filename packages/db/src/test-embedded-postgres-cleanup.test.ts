import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";

const dataDirs = new Set<string>();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const name of ["embedded-postgres", "./embedded-postgres-native.js", "./client.js", "node:child_process"]) vi.doUnmock(name);
  vi.resetModules();
  for (const dir of dataDirs) fs.rmSync(dir, { recursive: true, force: true });
  dataDirs.clear();
});

it("propagates failed scratch cleanup and permits an explicit later cleanup", async () => {
  vi.resetModules();
  vi.stubEnv("PAPERCLIP_TEST_DATABASE_URL", "");
  vi.doMock("embedded-postgres", () => ({
    default: class {
      constructor(options: { databaseDir: string }) { dataDirs.add(options.databaseDir); }
      async initialise() {}
      async start() {}
      async stop() {}
    },
  }));
  vi.doMock("./embedded-postgres-native.js", () => ({ prepareEmbeddedPostgresNativeRuntime: async () => {} }));
  vi.doMock("./client.js", () => ({ applyPendingMigrations: async () => {}, ensurePostgresDatabase: async () => {} }));
  // Termination discovery is simulated; this test never terminates host processes.
  vi.doMock("node:child_process", () => ({
    execFile: (...args: unknown[]) => (args.at(-1) as (error: null, stdout: string, stderr: string) => void)(null, "", ""),
  }));
  const { startEmbeddedPostgresTestDatabase } = await import("./test-embedded-postgres.js");
  const database = await startEmbeddedPostgresTestDatabase("synthetic-cleanup-control-");
  const removal = vi.spyOn(fs, "rmSync").mockImplementation(() => {
    throw Object.assign(new Error("synthetic locked scratch directory"), { code: "EPERM" });
  });
  try {
    await expect(database.cleanup()).rejects.toThrow("Embedded PostgreSQL test data directory cleanup failed");
    expect(removal).toHaveBeenCalledTimes(2);
    for (const dir of dataDirs) expect(fs.existsSync(dir)).toBe(true);
  } finally {
    removal.mockRestore();
    await database.cleanup();
  }
  for (const dir of dataDirs) expect(fs.existsSync(dir)).toBe(false);
});
