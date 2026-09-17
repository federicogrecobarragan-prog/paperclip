import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { HttpError } from "../errors.js";
import { trackErrorHandlerCrash } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import { COMPANY_IMPORT_API_PATH } from "../routes/company-import-paths.js";
import { SAFE_HTTP_ERROR_LOG_MESSAGE } from "./http-error-log-safety.js";

export interface ErrorContext {
  error: { message: string; stack?: string; name?: string; details?: unknown; raw?: unknown };
  method: string;
  url: string;
  reqBody?: unknown;
  reqParams?: unknown;
  reqQuery?: unknown;
}

function attachErrorContext(
  req: Request,
  res: Response,
) {
  (res as any).__errorContext = {
    error: {
      message: SAFE_HTTP_ERROR_LOG_MESSAGE,
      name: "RequestError",
    },
    method: req.method,
    url: req.originalUrl,
  } satisfies ErrorContext;
  // pino-http automatically serializes `res.err` on 5xx responses. Never
  // attach the original exception because its message/stack can contain an
  // opaque provider, hook, database, or workspace diagnostic.
  (res as any).err = new Error(SAFE_HTTP_ERROR_LOG_MESSAGE);
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
      attachErrorContext(req, res);
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
  attachErrorContext(req, res);

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
