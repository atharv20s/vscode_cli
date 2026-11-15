import test from "node:test";
import assert from "node:assert/strict";
import { classifyCommandForPolicy, classifyFileOperationForPolicy, permissionEngine } from "./permissionEngine.js";

test("only narrow read-only inspection commands are auto-allowed", () => {
  for (const command of [
    "pwd",
    "git status",
    "git status --short",
    "git diff --stat",
    "git branch --show-current",
    "git log -5 --oneline",
    "node --version",
    "npm --version",
  ]) assert.equal(classifyCommandForPolicy(command), "ALLOW", command);
});

test("state-changing, network and unknown commands require approval", () => {
  for (const command of [
    "npm install",
    "npm test",
    "python -c 'print(1)'",
    "curl https://example.com",
    "git push origin main",
    "bash -c 'echo hello'",
    "echo hello",
    "git status && curl https://example.com",
  ]) assert.equal(classifyCommandForPolicy(command), "ASK", command);
});

test("high-impact destructive commands are denied", () => {
  for (const command of [
    "rm -rf /",
    "git reset --hard",
    "git push --force origin main",
    "npm publish",
    "drop database production",
    "sudo reboot",
    "cat /var/run/docker.sock",
    "cat .env",
    "cat ~/.aws/credentials",
    "cat /etc/shadow",
  ]) assert.equal(classifyCommandForPolicy(command), "DENY", command);
});

test("isolated repository agents can build and test without approval", () => {
  assert.equal(classifyCommandForPolicy("npm install", { isolatedRepoAgent: true }), "ALLOW");
  assert.equal(classifyCommandForPolicy("npm test", { isolatedRepoAgent: true }), "ALLOW");
  assert.equal(classifyCommandForPolicy("bash -lc 'npm test'", { isolatedRepoAgent: true }), "ALLOW");
});

test("destructive operations remain denied even in isolated repository agents", () => {
  assert.equal(classifyCommandForPolicy("rm -rf /workspace", { isolatedRepoAgent: true }), "DENY");
  assert.equal(classifyCommandForPolicy("git reset --hard", { isolatedRepoAgent: true }), "DENY");
});

test("empty and malformed commands fail closed", () => {
  assert.equal(classifyCommandForPolicy(""), "DENY");
  assert.equal(classifyCommandForPolicy(null), "DENY");
  assert.equal(classifyCommandForPolicy("pwd\npwd"), "ASK");
});

test("secret files cannot be read through file tools", () => {
  for (const path of [".env", ".env.production", "keys/id_rsa", "certs/private.pem", ".aws/credentials", "infra/terraform.tfstate"]) {
    assert.equal(classifyFileOperationForPolicy("read", path), "DENY", path);
  }
});

test("sensitive project configuration changes require approval", () => {
  for (const path of ["package.json", "package-lock.json", ".github/workflows/deploy.yml", "Dockerfile", "server/src/config/env.js"]) {
    assert.equal(classifyFileOperationForPolicy("write", path), "ASK", path);
  }
  assert.equal(classifyFileOperationForPolicy("edit", "src/App.jsx"), "ALLOW");
  assert.equal(classifyFileOperationForPolicy("delete", "src/App.jsx"), "ASK");
});

test("additional credential paths and unknown file actions fail closed", () => {
  for (const secretPath of [
    ".npmrc", ".netrc", ".pypirc", ".git-credentials",
    ".ssh/authorized_keys", ".ssh/known_hosts",
    "etc/shadow", "proc/123/environ",
  ]) assert.equal(classifyFileOperationForPolicy("read", secretPath), "DENY", secretPath);
  assert.equal(classifyFileOperationForPolicy("write", "nested/.github/workflows/deploy.yml"), "ASK");
  assert.equal(classifyFileOperationForPolicy("write", "terraform/main.tf"), "ASK");
  assert.equal(classifyFileOperationForPolicy("unknown", "src/App.jsx"), "ASK");
});

test("permission approvals cannot be resolved by another workspace", async () => {
  const pending = permissionEngine.checkPermission({
    resource: "command",
    action: "run_command",
    payload: { command: "echo approval-test" },
    workspaceId: "workspace-owner",
    timeout: 5000,
  });
  const [request] = permissionEngine.listPendingRequests();
  assert.ok(request?.permissionId);
  assert.equal(permissionEngine.resolvePermission(request.permissionId, true, "wrong workspace", "other-workspace"), false);
  assert.equal(permissionEngine.resolvePermission(request.permissionId, true, "approved", "workspace-owner"), true);
  const result = await pending;
  assert.equal(result.granted, true);
  assert.equal(result.decision, "ASK");
});
