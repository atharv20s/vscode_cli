import test from "node:test";
import assert from "node:assert/strict";

process.env.REPO_AGENT_TOKEN_KEY = "ab".repeat(32);
const { encryptRepoAgentToken, decryptRepoAgentToken } = await import("./repoAgentTokenVault.js");

test("GitHub task credentials are encrypted and authenticated", () => {
  const token = "ghp_test_token_that_must_not_be_stored_in_plaintext";
  const encrypted = encryptRepoAgentToken(token);
  assert.notEqual(encrypted.github_token_ciphertext, token);
  assert.ok(encrypted.github_token_iv);
  assert.ok(encrypted.github_token_tag);
  assert.equal(decryptRepoAgentToken(encrypted),token);

  const tampered = { ...encrypted, github_token_ciphertext: Buffer.from("tampered").toString("base64") };
  assert.throws(() => decryptRepoAgentToken(tampered));
});
