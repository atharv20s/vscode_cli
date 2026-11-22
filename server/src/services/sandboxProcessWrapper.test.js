import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSandboxedEnv, spawnSandboxedProcess } from "./sandboxProcessWrapper.js";

test("buildSandboxedEnv filters out sensitive credentials from process environment", () => {
  // Inject mock secret in process.env
  process.env.TEST_SECRET_API_KEY = "sk-1234567890";
  process.env.DATABASE_URL = "postgres://root:secret@localhost/db";

  const env = buildSandboxedEnv({ CUSTOM_VAR: "allowed" });
  assert.equal(env.CUSTOM_VAR, "allowed");
  assert.equal(env.TEST_SECRET_API_KEY, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.ok(env.PATH !== undefined || env.Path !== undefined);
  assert.equal(env.TERM, "dumb");
});

test("spawnSandboxedProcess constructs execution parameters without a shell", () => {
  const result = spawnSandboxedProcess({
    command: process.execPath,
    args: ["-e", "console.log('sandbox-ok')"],
    workspaceRoot: process.cwd(),
    platform: "win32",
  });

  assert.ok(result.child);
  assert.equal(result.sandboxed, false); // On Windows/dev fallback
  result.child.kill();
});

test("requires valid command and workspace root", () => {
  assert.throws(() => spawnSandboxedProcess({ command: "", workspaceRoot: "/ws" }), /valid command/);
  assert.throws(() => spawnSandboxedProcess({ command: "node", workspaceRoot: "" }), /workspaceRoot/);
});
