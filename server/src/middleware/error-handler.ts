import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { HttpError } from "../errors.js";
import { trackErrorHandlerCrash } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import { COMPANY_IMPORT_API_PATH } from "../routes/company-import-paths.js";

export interface ErrorContext {
  error: ErrorContextEntry;
  method: string;
  url: string;
  reqBody?: unknown;
  reqParams?: unknown;
  reqQuery?: unknown;
}

interface ErrorContextEntry {
  message: string;
  stack?: string;
  name?: string;
  details?: unknown;
  raw?: unknown;
  code?: string | number;
  detail?: string;
  constraint?: string;
  schema?: string;
  table?: string;
  column?: string;
  dataType?: string;
  severity?: string;
  hint?: string;
  where?: string;
  position?: string | number;
  routine?: string;
  cause?: ErrorContextEntry;
  truncated?: boolean;
}

const MAX_ERROR_CAUSE_DEPTH = 5;
const ERROR_CONTEXT_FIELDS = [
  "code",
  "detail",
  "constraint",
  "schema",
  "table",
  "column",
  "dataType",
  "severity",
  "hint",
  "where",
  "position",
  "routine",
] as const;

function readErrorProperty(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function isLoggableScalar(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

function serializeErrorContext(error: unknown, depth = 0): ErrorContextEntry {
  const errorObject = error !== null && typeof error === "object" ? error : null;
  const message = errorObject ? readErrorProperty(errorObject, "message") : undefined;
  const stack = errorObject ? readErrorProperty(errorObject, "stack") : undefined;
  const name = errorObject ? readErrorProperty(errorObject, "name") : undefined;
  const result: ErrorContextEntry = {
    message: typeof message === "string" ? message : String(error),
    ...(typeof stack === "string" ? { stack } : {}),
    ...(typeof name === "string" ? { name } : {}),
    ...(!errorObject ? { raw: error } : {}),
  };

  if (!errorObject) return result;

  for (const field of ERROR_CONTEXT_FIELDS) {
    const value = readErrorProperty(errorObject, field);
    if (isLoggableScalar(value)) {
      Object.assign(result, { [field]: value });
    }
  }

  const cause = readErrorProperty(errorObject, "cause");
  if (cause !== undefined) {
    result.cause = depth >= MAX_ERROR_CAUSE_DEPTH
      ? { message: "Error cause chain truncated", truncated: true }
      : serializeErrorContext(cause, depth + 1);
  }

  return result;
}

function attachErrorContext(
  req: Request,
  res: Response,
  payload: ErrorContext["error"],
  rawError?: Error,
) {
  (res as any).__errorContext = {
    error: payload,
    method: req.method,
    url: req.originalUrl,
    reqBody: req.body,
    reqParams: req.params,
    reqQuery: req.query,
  } satisfies ErrorContext;
  if (rawError) {
    (res as any).err = rawError;
  }
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof HttpError) {
    const details = err.details && typeof err.details === "object" && !Array.isArray(err.details)
      ? err.details as Record<string, unknown>
      : null;
    if (err.status >= 500) {
      attachErrorContext(
        req,
        res,
        { ...serializeErrorContext(err), details: err.details },
        err,
      );
      const tc = getTelemetryClient();
      if (tc) trackErrorHandlerCrash(tc, { errorCode: err.name });
    }
    res.status(err.status).json({
      error: err.message,
      ...(typeof details?.code === "string" ? { code: details.code } : {}),
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation error", details: err.errors });
    return;
  }

  const rootError = err instanceof Error ? err : new Error(String(err));
  attachErrorContext(
    req,
    res,
    err instanceof Error
      ? serializeErrorContext(err)
      : { ...serializeErrorContext(err), raw: err, stack: rootError.stack, name: rootError.name },
    rootError,
  );

  const tc = getTelemetryClient();
  if (tc) trackErrorHandlerCrash(tc, { errorCode: rootError.name });

  res.status(500).json({
    error: "Internal server error",
    ...(shouldExposeTrustedCloudTenantImportError(req) ? { message: rootError.message } : {}),
  });
}

function shouldExposeTrustedCloudTenantImportError(req: Request) {
  return req.actor?.source === "cloud_tenant"
    && req.method === "POST"
    && req.originalUrl.split("?")[0] === COMPANY_IMPORT_API_PATH;
}
