import { describe, expect, it } from "vitest";
import { validateExternalTestDatabaseUrl } from "./test-embedded-postgres.js";

describe("external PostgreSQL test database safety", () => {
  it.each([
    "postgres://paperclip:secret@localhost/paperclip",
    "postgres://paperclip:secret@localhost/production",
    "postgres://paperclip:secret@localhost/contest",
    "postgres://paperclip:secret@localhost/paperclip_test%2Fproduction",
    "https://localhost/paperclip_test",
    "not a URL",
  ])("fails closed for a non-exclusive destination: %s", (url) => {
    expect(() => validateExternalTestDatabaseUrl(url)).toThrow();
  });

  it.each([
    "postgres://paperclip:secret@localhost/paperclip_test",
    "postgresql://paperclip:secret@localhost/paperclip-ci",
    "postgres://paperclip:secret@localhost/test",
    "postgres://paperclip:secret@localhost/ephemeral_paperclip",
  ])("accepts an unmistakable test control database: %s", (url) => {
    expect(validateExternalTestDatabaseUrl(url)).toBeInstanceOf(URL);
  });
});
