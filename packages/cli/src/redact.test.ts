import { describe, expect, it } from "vitest";
import { boundedText, redactSecrets } from "#redact";

describe("redactSecrets", () => {
  it("removes bearer tokens, keys and private keys", () => {
    const text = [
      "Authorization: Bearer abc123def456ghi",
      "api_key = sk-livetokenvalue1234567",
      'export REINTERSECT_API_KEY="rei_abcdefghijklmnop"',
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_0123456789abcdefghij",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const redacted = redactSecrets(text);

    expect(redacted).not.toContain("abc123def456ghi");
    expect(redacted).not.toContain("sk-livetokenvalue1234567");
    expect(redacted).not.toContain("rei_abcdefghijklmnop");
    expect(redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(redacted).not.toContain("ghp_0123456789abcdefghij");
    expect(redacted).not.toContain("MIIabc");
    expect(redacted.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it("redacts json credential fields", () => {
    expect(redactSecrets('{"password":"hunter2","port":5432}')).toContain(
      '"password":"[REDACTED]"',
    );
  });

  it("leaves ordinary prose alone", () => {
    expect(redactSecrets("run pnpm test in packages/cli")).toBe("run pnpm test in packages/cli");
  });

  it("truncates with a visible marker", () => {
    expect(boundedText("x".repeat(30), 10)).toBe(`${"x".repeat(10)}\n...[truncated 20 chars]`);
  });
});
