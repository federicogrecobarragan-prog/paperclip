import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import postgres from "postgres";
import { applyPendingMigrations, ensurePostgresDatabase } from "./client.js";
import { prepareEmbeddedPostgresNativeRuntime } from "./embedded-postgres-native.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

export type EmbeddedPostgresTestSupport = {
  supported: boolean;
  reason?: string;
};

export type EmbeddedPostgresTestDatabase = {
  connectionString: string;
  cleanup(): Promise<void>;
};

let embeddedPostgresSupportPromise: Promise<EmbeddedPostgresTestSupport> | null = null;

const DEFAULT_PAPERCLIP_EMBEDDED_POSTGRES_PORT = 54329;
const DEFAULT_EMBEDDED_POSTGRES_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_EMBEDDED_POSTGRES_STOP_TIMEOUT_MS = 2_000;
const DEFAULT_EXTERNAL_TEST_DATABASE_HOSTS = ["localhost", "127.0.0.1", "::1"];
const execFileAsync = promisify(execFile);

function getExternalTestDatabaseUrl(): string | null {
  return process.env.PAPERCLIP_TEST_DATABASE_URL?.trim() || null;
}

const EXPLICIT_TEST_DATABASE_NAME = /(^|[_-])(test|testing|ci|tmp|temp|ephemeral)([_-]|$)/i;

function normalizeDatabaseHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function getAllowedExternalTestDatabaseHosts(): Set<string> {
  return new Set(
    [
      ...DEFAULT_EXTERNAL_TEST_DATABASE_HOSTS,
      ...String(process.env.PAPERCLIP_TEST_DATABASE_ALLOWED_HOSTS ?? "").split(","),
    ]
      .map((hostname) => normalizeDatabaseHostname(hostname.trim()))
      .filter(Boolean),
  );
}

export function validateExternalTestDatabaseUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("PAPERCLIP_TEST_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("PAPERCLIP_TEST_DATABASE_URL must use the postgres or postgresql protocol");
  }
  const hostname = normalizeDatabaseHostname(parsed.hostname);
  if (!getAllowedExternalTestDatabaseHosts().has(hostname)) {
    throw new Error(
      `PAPERCLIP_TEST_DATABASE_URL host "${parsed.hostname}" is not explicitly allowed; ` +
      "use a loopback host or add the exact hostname to PAPERCLIP_TEST_DATABASE_ALLOWED_HOSTS",
    );
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName || databaseName.includes("/") || !EXPLICIT_TEST_DATABASE_NAME.test(databaseName)) {
    throw new Error(
      "PAPERCLIP_TEST_DATABASE_URL must name an unmistakable test database " +
      "(for example paperclip_test); refusing to migrate a shared or production-looking destination",
    );
  }
  return parsed;
}

function quoteDatabaseIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error("Unsafe generated test database name");
  return `"${value}"`;
}

function databaseUrl(base: URL, databaseName: string): string {
  const result = new URL(base.toString());
  result.pathname = `/${databaseName}`;
  return result.toString();
}

async function dropExternalTestDatabase(adminUrl: string, databaseName: string): Promise<void> {
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    const quotedDatabaseName = quoteDatabaseIdentifier(databaseName);
    await sql.unsafe(`DROP DATABASE IF EXISTS ${quotedDatabaseName} WITH (FORCE)`);
    const remaining = await sql<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${databaseName}) AS exists
    `;
    if (remaining[0]?.exists) {
      throw new Error("External PostgreSQL test database cleanup could not be verified");
    }
  } finally {
    await sql.end();
  }
}

async function startExternalPostgresTestDatabase(rawUrl: string): Promise<EmbeddedPostgresTestDatabase> {
  const baseUrl = validateExternalTestDatabaseUrl(rawUrl);
  const databaseName = `paperclip_test_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = baseUrl.toString();
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`CREATE DATABASE ${quoteDatabaseIdentifier(databaseName)}`);
  } finally {
    await sql.end();
  }

  const connectionString = databaseUrl(baseUrl, databaseName);
  try {
    await applyPendingMigrations(connectionString);
  } catch (error) {
    try {
      await dropExternalTestDatabase(adminUrl, databaseName);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "External PostgreSQL test database migration failed and cleanup could not be verified",
      );
    }
    throw error;
  }

  let cleaned = false;
  return {
    connectionString,
    cleanup: async () => {
      if (cleaned) return;
      await dropExternalTestDatabase(adminUrl, databaseName);
      cleaned = true;
    },
  };
}

function getReservedTestPorts(): Set<number> {
  const configuredPorts = [
    DEFAULT_PAPERCLIP_EMBEDDED_POSTGRES_PORT,
    Number.parseInt(process.env.PAPERCLIP_EMBEDDED_POSTGRES_PORT ?? "", 10),
    ...String(process.env.PAPERCLIP_TEST_POSTGRES_RESERVED_PORTS ?? "")
      .split(",")
      .map((value) => Number.parseInt(value.trim(), 10)),
  ];
  return new Set(configuredPorts.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535));
}

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  await prepareEmbeddedPostgresNativeRuntime();
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  const reservedPorts = getReservedTestPorts();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close(() => reject(new Error("Failed to allocate test port")));
          return;
        }
        const { port } = address;
        server.close((error) => {
          if (error) reject(error);
          else resolve(port);
        });
      });
    });

    if (!reservedPorts.has(port)) return port;
  }

  throw new Error(
    `Failed to allocate embedded Postgres test port outside reserved Paperclip ports: ${[
      ...reservedPorts,
    ].join(", ")}`,
  );
}

async function createEmbeddedPostgresTestInstance(tempDirPrefix: string) {
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), tempDirPrefix));
  try {
    const instance = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: "paperclip",
      password: "paperclip",
      port,
      persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
      onLog: () => {},
      onError: () => {},
    });

    return { dataDir, port, instance };
  } catch (error) {
    cleanupEmbeddedPostgresTestDirs(dataDir);
    throw error;
  }
}

function cleanupEmbeddedPostgresTestDirs(dataDir: string) {
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function terminateEmbeddedPostgresProcessesForDataDir(dataDir: string): Promise<void> {
  if (process.platform === "win32") {
    const script = [
      "$target = $env:PAPERCLIP_TEST_POSTGRES_DATA_DIR",
      "Get-CimInstance Win32_Process | Where-Object {",
      "  $processName = [string]$_.Name",
      "  $commandLine = [string]$_.CommandLine",
      "  ($processName -ieq \"initdb.exe\" -or $processName -ieq \"postgres.exe\") -and",
      "    $commandLine.Contains($target)",
      "} | ForEach-Object {",
      "  & taskkill.exe /PID ([string]$_.ProcessId) /T /F | Out-Null",
      "}",
    ].join("\n");
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, PAPERCLIP_TEST_POSTGRES_DATA_DIR: dataDir },
      timeout: 5_000,
      windowsHide: true,
    });
    return;
  }

  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,args="], { timeout: 5_000 });
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1]!, 10);
    const commandLine = match[2]!;
    if (
      pid !== process.pid &&
      (commandLine.includes(`--pgdata=${dataDir}`) || commandLine.includes(`-D ${dataDir}`))
    ) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }
}

async function removeEmbeddedPostgresTestDir(dataDir: string): Promise<void> {
  try {
    cleanupEmbeddedPostgresTestDirs(dataDir);
  } catch (initialCleanupError) {
    let terminationError: unknown;
    try {
      await terminateEmbeddedPostgresProcessesForDataDir(dataDir);
    } catch (error) {
      terminationError = error;
    }

    try {
      cleanupEmbeddedPostgresTestDirs(dataDir);
    } catch (retryCleanupError) {
      throw new AggregateError(
        [initialCleanupError, terminationError, retryCleanupError].filter(Boolean),
        "Embedded PostgreSQL test data directory cleanup failed after terminating its processes",
      );
    }
  }
}

function formatEmbeddedPostgresError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return "embedded Postgres startup failed";
}

function getEmbeddedPostgresStartupTimeoutMs(): number {
  const configured = Number.parseInt(
    process.env.PAPERCLIP_EMBEDDED_POSTGRES_STARTUP_TIMEOUT_MS ?? "",
    10,
  );
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_EMBEDDED_POSTGRES_STARTUP_TIMEOUT_MS;
}

async function runEmbeddedPostgresOperationWithTimeout<T>(
  operation: () => Promise<T>,
  phase: string,
  timeoutMs: number,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Embedded PostgreSQL ${phase} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function startEmbeddedPostgresInstance(
  instance: EmbeddedPostgresInstance,
  timeoutMs: number,
): Promise<void> {
  await runEmbeddedPostgresOperationWithTimeout(
    () => instance.initialise(),
    "initialise",
    timeoutMs,
  );
  await runEmbeddedPostgresOperationWithTimeout(() => instance.start(), "start", timeoutMs);
}

async function cleanupEmbeddedPostgresTestInstance(
  instance: EmbeddedPostgresInstance | null,
  dataDir: string | null,
  startupTimeoutMs: number,
): Promise<void> {
  try {
    if (instance) {
      await runEmbeddedPostgresOperationWithTimeout(
        () => instance.stop(),
        "stop",
        Math.min(startupTimeoutMs, DEFAULT_EMBEDDED_POSTGRES_STOP_TIMEOUT_MS),
      ).catch(() => {});
    }
  } finally {
    if (dataDir) await removeEmbeddedPostgresTestDir(dataDir);
  }
}

async function probeEmbeddedPostgresSupport(): Promise<EmbeddedPostgresTestSupport> {
  let dataDir: string | null = null;
  let instance: EmbeddedPostgresInstance | null = null;
  const startupTimeoutMs = getEmbeddedPostgresStartupTimeoutMs();

  try {
    const created = await createEmbeddedPostgresTestInstance(
      "paperclip-embedded-postgres-probe-",
    );
    dataDir = created.dataDir;
    instance = created.instance;
    await startEmbeddedPostgresInstance(instance, startupTimeoutMs);
    return { supported: true };
  } catch (error) {
    return {
      supported: false,
      reason: formatEmbeddedPostgresError(error),
    };
  } finally {
    await cleanupEmbeddedPostgresTestInstance(instance, dataDir, startupTimeoutMs);
  }
}

export async function getEmbeddedPostgresTestSupport(): Promise<EmbeddedPostgresTestSupport> {
  const externalTestDatabaseUrl = getExternalTestDatabaseUrl();
  if (externalTestDatabaseUrl) {
    validateExternalTestDatabaseUrl(externalTestDatabaseUrl);
    return { supported: true };
  }
  if (!embeddedPostgresSupportPromise) {
    embeddedPostgresSupportPromise = probeEmbeddedPostgresSupport();
  }
  return await embeddedPostgresSupportPromise;
}

export async function startEmbeddedPostgresTestDatabase(
  tempDirPrefix: string,
): Promise<EmbeddedPostgresTestDatabase> {
  const externalTestDatabaseUrl = getExternalTestDatabaseUrl();
  if (externalTestDatabaseUrl) {
    return startExternalPostgresTestDatabase(externalTestDatabaseUrl);
  }

  let dataDir: string | null = null;
  let instance: EmbeddedPostgresInstance | null = null;
  const startupTimeoutMs = getEmbeddedPostgresStartupTimeoutMs();

  try {
    const created = await createEmbeddedPostgresTestInstance(tempDirPrefix);
    dataDir = created.dataDir;
    instance = created.instance;
    const { port } = created;
    await startEmbeddedPostgresInstance(instance, startupTimeoutMs);

    const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminConnectionString, "paperclip");
    const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    await applyPendingMigrations(connectionString);

    let cleaned = false;
    return {
      connectionString,
      cleanup: async () => {
        if (cleaned) return;
        await cleanupEmbeddedPostgresTestInstance(instance, dataDir, startupTimeoutMs);
        cleaned = true;
      },
    };
  } catch (error) {
    await cleanupEmbeddedPostgresTestInstance(instance, dataDir, startupTimeoutMs);
    throw new Error(
      `Failed to start embedded PostgreSQL test database: ${formatEmbeddedPostgresError(error)}`,
    );
  }
}
