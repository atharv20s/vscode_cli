import test from "node:test";
import assert from "node:assert/strict";
import { redactSensitiveOutput } from "./agentOutputSafety.js";

test("redacts private keys and common provider tokens", () => {
  const input = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "super-secret-material",
    "-----END RSA PRIVATE KEY-----",
    "ghp_123456789012345678901234567890123456",
    "AKIA1234567890ABCDEF",
    "sk-proj-12345678901234567890123456789012",
  ].join("\n");
  const result = redactSensitiveOutput(input);
  assert.equal(result.changed, true);
  assert.match(result.text, /REDACTED PRIVATE KEY/);
  assert.match(result.text, /REDACTED GITHUB TOKEN/);
  assert.match(result.text, /REDACTED AWS ACCESS KEY/);
  assert.match(result.text, /REDACTED API TOKEN/);
  assert.ok(!result.text.includes("super-secret-material"));
});

test("redacts credential assignments without modifying ordinary prose", () => {
  const result = redactSensitiveOutput("JWT_SECRET=my-sensitive-value\nThis is a normal sentence.");
  assert.match(result.text, /JWT_SECRET=\[REDACTED\]/);
  assert.match(result.text, /This is a normal sentence/);
});
