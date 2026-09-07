export const SAFE_HTTP_ERROR_LOG_MESSAGE =
  "Request failed; raw diagnostic omitted";

export function buildSafeHttpErrorLogObject(value: unknown) {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
  delete record.err;
  return {
    ...record,
    err: {
      type: "RequestError",
      message: SAFE_HTTP_ERROR_LOG_MESSAGE,
    },
  };
}
