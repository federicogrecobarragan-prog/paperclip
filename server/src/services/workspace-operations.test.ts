import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import {
  sanitizeWorkspaceOperationMetadataForPersistence,
  sanitizeWorkspaceOperationTextForPersistence,
} from "./workspace-operations.js";

describe("workspace operation persistence redaction", () => {
  it("redacts secrets from command and log text before persistence", () => {
    const secret = "workspace-operation-secret";
    const result = sanitizeWorkspaceOperationTextForPersistence(
      `adapter failed: env OPENAI_API_KEY=${secret} --token ${secret}`,
      { enabled: false },
    );

    expect(result).not.toContain(secret);
    expect(result).toContain(REDACTED_EVENT_VALUE);
  });

  it("redacts keyed and embedded secrets recursively from metadata", () => {
    const secret = "workspace-operation-secret";
    const result = sanitizeWorkspaceOperationMetadataForPersistence(
      {
        apiKey: secret,
        errorMessage: `adapter failed: env OPENAI_API_KEY=${secret}`,
        nested: {
          authorization: `Bearer ${secret}`,
          commandArgs: ["--token", secret, "safe"],
        },
      },
      { enabled: false },
    );

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).toMatchObject({
      apiKey: REDACTED_EVENT_VALUE,
      errorMessage: `adapter failed: env OPENAI_API_KEY=${REDACTED_EVENT_VALUE}`,
      nested: {
        authorization: REDACTED_EVENT_VALUE,
        commandArgs: ["--token", REDACTED_EVENT_VALUE, "safe"],
      },
    });
  });

  it("bounds hostile metadata without invoking accessors and removes U+0000", () => {
    let getterInvoked = false;
    const metadata: Record<string, unknown> = {
      message: "before\u0000after",
    };
    metadata.self = metadata;
    Object.defineProperty(metadata, "apiKey", {
      enumerable: true,
      get() {
        getterInvoked = true;
        throw new Error("must not execute metadata getters");
      },
    });

    const result = sanitizeWorkspaceOperationMetadataForPersistence(
      metadata,
      { enabled: false },
    );

    expect(getterInvoked).toBe(false);
    expect(result).toMatchObject({
      message: "before\uFFFDafter",
      self: "[Circular]",
    });
    expect(result).not.toHaveProperty("apiKey");
    expect(JSON.stringify(result)).not.toContain("\u0000");
  });
});
