import test from "node:test";
import assert from "node:assert/strict";
import { classifyCommandForPolicy } from "./permissionEngine.js";

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
    "cat .env",
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
  ]) assert.equal(classifyCommandForPolicy(command), "DENY", command);
});

test("empty and malformed commands fail closed", () => {
  assert.equal(classifyCommandForPolicy(""), "DENY");
  assert.equal(classifyCommandForPolicy(null), "DENY");
  assert.equal(classifyCommandForPolicy("pwd\npwd"), "ASK");
});
