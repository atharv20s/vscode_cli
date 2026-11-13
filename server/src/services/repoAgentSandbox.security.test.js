import test from "node:test";
import assert from "node:assert/strict";
import { classifyCommandForPolicy, classifyFileOperationForPolicy } from "./permissionEngine.js";

test("repository-agent sandbox permits ordinary build work but never secret access", () => {
  assert.equal(classifyCommandForPolicy("npm test", { isolatedRepoAgent: true }), "ALLOW");
  assert.equal(classifyCommandForPolicy("npm install", { isolatedRepoAgent: true }), "ALLOW");
  assert.equal(classifyCommandForPolicy("rm -rf /workspace", { isolatedRepoAgent: true }), "DENY");
  assert.equal(classifyFileOperationForPolicy("write", "package.json", { isolatedRepoAgent: true }), "ALLOW");
  assert.equal(classifyFileOperationForPolicy("delete", "src/old.js", { isolatedRepoAgent: true }), "ALLOW");
  assert.equal(classifyFileOperationForPolicy("read", ".env", { isolatedRepoAgent: true }), "DENY");
  assert.equal(classifyFileOperationForPolicy("write", ".env", { isolatedRepoAgent: true }), "DENY");
});
