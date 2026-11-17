import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeSecrets, sanitizeObject } from "./secretSanitizer.js";

test("redacts GitHub personal access tokens", () => {
  const input = "Deploy failed with token: ghp_1234567890abcdefghijklmnopqrstuvwxyz1234";
  const output = sanitizeSecrets(input);
  assert.ok(!output.includes("ghp_1234567890"));
  assert.ok(output.includes("[REDACTED_GITHUB_TOKEN]"));
});

test("redacts OpenAI and Anthropic API keys", () => {
  const input = "Using key sk-proj-12345678901234567890123456789012 and sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234";
  const output = sanitizeSecrets(input);
  assert.ok(!output.includes("sk-proj-1234"));
  assert.ok(!output.includes("sk-ant-api03"));
  assert.ok(output.includes("[REDACTED_OPENAI_KEY]"));
  assert.ok(output.includes("[REDACTED_ANTHROPIC_KEY]"));
});

test("redacts AWS access keys", () => {
  const input = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
  const output = sanitizeSecrets(input);
  assert.ok(!output.includes("AKIAIOSFODNN7EXAMPLE"));
  assert.ok(output.includes("[REDACTED_AWS_ACCESS_KEY]"));
});

test("redacts passwords inside database connection URLs", () => {
  const input = "Connecting to postgresql://postgres:SuperSecretPassword123@localhost:5432/ath_ide_db";
  const output = sanitizeSecrets(input);
  assert.ok(!output.includes("SuperSecretPassword123"));
  assert.ok(output.includes("postgresql://postgres:[REDACTED_SECRET]@localhost:5432/ath_ide_db"));
});

test("redacts PEM private key blocks", () => {
  const input = `Key loaded:
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y1234567890abcdef...
-----END RSA PRIVATE KEY-----
Proceeding...`;
  const output = sanitizeSecrets(input);
  assert.ok(!output.includes("MIIEowIBAAKCAQEA0Y1234567890abcdef"));
  assert.ok(output.includes("[REDACTED_PRIVATE_KEY]"));
});

test("redacts JSON key-value secrets in structured logs", () => {
  const input = '{"status":"ok", "api_key": "mySecretPassword1234"}';
  const output = sanitizeSecrets(input);
  assert.ok(!output.includes("mySecretPassword1234"));
  assert.ok(output.includes('"api_key": "[REDACTED_SECRET]"'));
});

test("sanitizeObject recursively sanitizes objects and arrays", () => {
  const obj = {
    user: "alice",
    meta: {
      token: "ghp_1234567890abcdefghijklmnopqrstuvwxyz1234",
      db: "postgres://u:secretPass@localhost/db",
    },
    items: ["normal", "AWS key: AKIAIOSFODNN7EXAMPLE"],
  };
  const sanitized = sanitizeObject(obj);
  assert.equal(sanitized.user, "alice");
  assert.ok(!sanitized.meta.token.includes("ghp_"));
  assert.ok(!sanitized.meta.db.includes("secretPass"));
  assert.ok(!sanitized.items[1].includes("AKIA"));
});
