#!/usr/bin/env node
/**
 * Deployed API multi-user isolation acceptance test.
 *
 * Run on a trusted operator machine with the production API URL and JWT
 * signing secret. The script mints short-lived tokens for two random synthetic
 * identities (no real user accounts are read or modified), concurrently writes
 * the same relative filename, verifies each identity sees only its own content,
 * and removes both test files.
 */
import crypto from "node:crypto";
import "../server/src/config/env.js";
import crypto from "node:crypto";

const baseUrl = new URL(process.env.WORKSPACE_API_URL || "");
const jwtSecret = process.env.JWT_SECRET || "";
if (!["https:", "http:"].includes(baseUrl.protocol)) {
  throw new Error("WORKSPACE_API_URL must be a valid HTTPS URL (HTTP is permitted only for local testing).");
}
if (baseUrl.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(baseUrl.hostname)) {
  throw new Error("Refusing to send synthetic bearer tokens over non-local HTTP.");
}
if (jwtSecret.length < 32) throw new Error("JWT_SECRET must be loaded from the API environment.");

const runId = crypto.randomUUID();
const filePath = "acceptance/multi-user-" + runId + ".txt";
const userA = "ath-acceptance-a-" + runId;
const userB = "ath-acceptance-b-" + runId;
const contentA = "ATH-ISOLATION-A:" + crypto.randomBytes(24).toString("hex");
const contentB = "ATH-ISOLATION-B:" + crypto.randomBytes(24).toString("hex");
function signSyntheticToken(id, username) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ id, username, iat: now, exp: now + 300 })).toString("base64url");
  const unsigned = header + "." + payload;
  const signature = crypto.createHmac("sha256", jwtSecret).update(unsigned).digest("base64url");
  return unsigned + "." + signature;
}
const tokenA = signSyntheticToken(userA, "Acceptance A");
const tokenB = signSyntheticToken(userB, "Acceptance B");

async function request(token, method, body) {
  const target = new URL("/api/workspace/file?path=" + encodeURIComponent(filePath), baseUrl);
  const response = await fetch(target, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(body === undefined ? {} : {
        "content-type": "application/json",
        "if-none-match": "*",
      }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify({ path: filePath, content: body }) }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

let passed = false;
try {
  const [writeA, writeB] = await Promise.all([
    request(tokenA, "POST", contentA),
    request(tokenB, "POST", contentB),
  ]);
  if (writeA.status !== 200 || !writeA.data.success) throw new Error("Synthetic user A write failed: HTTP " + writeA.status);
  if (writeB.status !== 200 || !writeB.data.success) throw new Error("Synthetic user B write failed: HTTP " + writeB.status);

  const [readA, readB] = await Promise.all([
    request(tokenA, "GET"),
    request(tokenB, "GET"),
  ]);
  if (readA.status !== 200 || readA.data.content !== contentA) throw new Error("User A did not read back its own isolated content.");
  if (readB.status !== 200 || readB.data.content !== contentB) throw new Error("User B did not read back its own isolated content.");
  passed = true;
  console.log(JSON.stringify({
    success: true,
    test: "deployed-api-concurrent-multi-user-workspace-isolation",
    simultaneousWrites: true,
    userAOwnContentVerified: true,
    userBOwnContentVerified: true,
    crossUserContentLeak: false,
    syntheticUsersOnly: true,
    workspaceFile: filePath,
  }, null, 2));
} finally {
  const results = await Promise.all([
    request(tokenA, "DELETE").then(result => ({ user: "A", status: result.status })),
    request(tokenB, "DELETE").then(result => ({ user: "B", status: result.status })),
  ]);
  if (results.some(result => result.status !== 200 && result.status !== 404)) {
    console.error("Acceptance cleanup needs attention:", JSON.stringify(results));
  }
  if (!passed) console.error(JSON.stringify({ success: false, test: "deployed-api-concurrent-multi-user-workspace-isolation", cleanup: results }));
}
