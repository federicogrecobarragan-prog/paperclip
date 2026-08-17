import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";

function makeReq(): Request {
  return {
    method: "GET",
    originalUrl: "/api/test",
    body: { a: 1 },
    params: { id: "123" },
    query: { q: "x" },
  } as unknown as Request;
}

function makeRes(): Response {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Response;
  (res.status as unknown as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

describe("errorHandler", () => {
  it("attaches the original Error to res.err for 500s", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new Error("boom");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    expect(res.err).toBe(err);
    expect(res.__errorContext?.error?.message).toBe("boom");
  });

  it("exposes raw 500 messages for trusted Cloud tenant imports", () => {
    const req = {
      ...makeReq(),
      method: "POST",
      originalUrl: "/api/companies/import",
      actor: {
        type: "board",
        userId: "cloud-user",
        source: "cloud_tenant",
      },
    } as unknown as Request;
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new Error("portable file references missing upload id");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: "Internal server error",
      message: "portable file references missing upload id",
    });
    expect(res.err).toBe(err);
  });

  it("attaches HttpError instances for 500 responses", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new HttpError(500, "db exploded");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "db exploded" });
    expect(res.err).toBe(err);
    expect(res.__errorContext?.error?.message).toBe("db exploded");
  });

  it("logs recursive database error causes without exposing them in the HTTP response", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const pgError = Object.assign(new Error("invalid byte sequence for encoding UTF8: 0x00"), {
      code: "22021",
      detail: "String contains a NUL byte",
      constraint: "issue_comments_body_check",
    });
    const err = new Error("Failed query: insert into issue_comments", { cause: pgError });

    errorHandler(err, req, res, next);

    expect(res.__errorContext?.error?.cause).toMatchObject({
      message: "invalid byte sequence for encoding UTF8: 0x00",
      code: "22021",
      detail: "String contains a NUL byte",
      constraint: "issue_comments_body_check",
    });
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    expect(JSON.stringify((res.json as ReturnType<typeof vi.fn>).mock.calls)).not.toContain("22021");
  });

  it("caps recursive error cause logging", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    let err: Error = new Error("deepest");
    for (let index = 0; index < 8; index += 1) {
      err = new Error(`wrapper-${index}`, { cause: err });
    }

    errorHandler(err, req, res, next);

    let context = res.__errorContext?.error;
    while (context?.cause && !context.cause.truncated) context = context.cause;
    expect(context?.cause).toEqual({ message: "Error cause chain truncated", truncated: true });
  });
});
