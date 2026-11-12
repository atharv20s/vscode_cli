import crypto from "crypto";
import { config } from "../config/env.js";

function getKey() {
  const key = config.repoAgentTokenKey || "";
  if (!/^[a-f0-9]{64}$/i.test(key)) {
    throw new Error("REPO_AGENT_TOKEN_KEY must be configured as 64 hexadecimal characters on the API and every repository worker.");
  }
  return Buffer.from(key,"hex");
}

/**
 * Encrypt a user's GitHub credential before it is placed in shared task state.
 * The raw credential is never written to Redis, workspace files or model context.
 */
export function encryptRepoAgentToken(token) {
  if (typeof token !== "string" || !token) throw new Error("A GitHub token is required.");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm",getKey(),iv);
  const ciphertext = Buffer.concat([cipher.update(token,"utf8"),cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    github_token_ciphertext: ciphertext.toString("base64"),
    github_token_iv: iv.toString("base64"),
    github_token_tag: tag.toString("base64"),
  };
}

export function decryptRepoAgentToken(record) {
  if (!record?.github_token_ciphertext || !record.github_token_iv || !record.github_token_tag) {
    throw new Error("The task has no encrypted GitHub credential snapshot.");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getKey(),
    Buffer.from(record.github_token_iv,"base64")
  );
  decipher.setAuthTag(Buffer.from(record.github_token_tag,"base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(record.github_token_ciphertext,"base64")),
    decipher.final(),
  ]).toString("utf8");
}
