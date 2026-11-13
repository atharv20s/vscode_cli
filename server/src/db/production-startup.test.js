import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const productionEnv = {
  ...process.env,
  NODE_ENV: "production",
  DATABASE_URL: "",
  DATABASE_URL_UNPOOLED: "",
  DIRECT_DATABASE_URL: "",
  JWT_SECRET: "ci-production-startup-secret-with-more-than-32-characters",
  EXECUTION_RUNTIME: "docker",
  REDIS_URL: "redis://127.0.0.1:6379",
  REPO_AGENT_TOKEN_KEY: "a".repeat(64),
  DOCKER_WORKSPACE_UID: "1000",
  DOCKER_WORKSPACE_GID: "1000",
};

function assertFailsClosed(entrypoint, label) {
  const result = spawnSync(process.execPath, [path.join(serverRoot, entrypoint)], {
    cwd: serverRoot,
    env: productionEnv,
    encoding: "utf8",
    timeout: 15000,
  });
  const output = (result.stdout || "") + (result.stderr || "");
  assert.equal(result.error, undefined, label + " process should start and report its configuration error");
  assert.notEqual(result.status, 0, label + " must not start without PostgreSQL");
  assert.match(output, /DATABASE_URL is required in production/, label + " should identify the missing production database");
}

test("production API refuses to start without DATABASE_URL", () => {
  assertFailsClosed("src/server.js", "API");
});

test("production repository worker refuses to start without DATABASE_URL", () => {
  assertFailsClosed("src/worker/repoAgentWorker.js", "Repository worker");
});
