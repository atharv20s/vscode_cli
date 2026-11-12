import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = relative => fs.readFile(path.resolve(here, relative), "utf8");

test("repository agent tasks receive isolated task-owned workspaces and leased execution", async () => {
  const service = await read("./repoAgentService.js");
  const queue = await read("./repoAgentQueue.js");
  const workspace = await read("./workspaceService.js");
  const runtime = await read("./dockerWorkspaceRuntime.js");

  assert.match(service, /path\.join\(config\.workspaceRoot, "\.agent-runs", taskId\)/);
  assert.match(service, /const repoPath = path\.join\(taskDir, "repo"\)/);
  assert.match(service, /"repo-agent-" \+ taskId/);
  assert.match(service, /createScopedWorkspaceService\(repoPath, workspaceId\)/);
  assert.match(service, /ensureContainer\(workspaceId, repoPath/);
  assert.match(service, /assertLease/);
  assert.match(queue, /acquireLease\(taskId/);
  assert.match(queue, /renewLease\(taskId/);
  assert.match(workspace, /task-scoped workspace/);
  assert.match(runtime, /function containerName\(workspaceId\)/);
});

test("distinct repository agent task IDs cannot resolve to the same workspace path", () => {
  const root = path.resolve("/workspace/.agent-runs");
  const first = path.join(root, "task-a", "repo");
  const second = path.join(root, "task-b", "repo");
  assert.notEqual(first, second);
  assert.equal(path.dirname(first), path.dirname(second));
});
