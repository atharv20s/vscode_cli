/**
 * ATH IDE 2.0 — Sandbox Security & Adversarial Isolation Test Suite
 *
 * Verifies the complete security boundary for Milestone 2.0 (PR #64):
 *  1. Process isolation & cgroups resource constraints
 *  2. Workspace filesystem boundary & symlink defense
 *  3. Network egress lockdown
 *  4. Universal policy engine command/file classification
 *  5. Secret redaction and credential protection
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";

import { buildBubblewrapArgs, makeUnitName, resolveWorkspacePaths } from "./backends/linuxSandboxBackend.js";
import { workspaceNetworkName, workspaceSecurityOptions } from "./dockerWorkspaceRuntime.js";
import { classifyCommandForPolicy, classifyFileOperationForPolicy } from "./permissionEngine.js";
import { sanitizeSecrets } from "./secretSanitizer.js";

// ---------------------------------------------------------------------------
// 1. Process Isolation & cgroup v2 Limits
// ---------------------------------------------------------------------------

test("sandbox isolates user, pid, ipc, uts and network namespaces", () => {
  const args = buildBubblewrapArgs({
    workspaceRoot: "/srv/workspaces/tenant-123",
    workingDirectory: "/workspace",
    command: "npm test",
    networkMode: "none",
    systemPaths: ["/usr", "/bin"],
    etcFiles: ["/etc/hosts"],
  });

  assert.ok(args.includes("--unshare-user"), "must unshare user namespace");
  assert.ok(args.includes("--unshare-pid"), "must unshare pid namespace");
  assert.ok(args.includes("--unshare-ipc"), "must unshare ipc namespace");
  assert.ok(args.includes("--unshare-uts"), "must unshare uts namespace");
  assert.ok(args.includes("--unshare-net"), "must unshare network namespace by default");
  assert.ok(args.includes("--clearenv"), "must clear host environment");
  assert.ok(args.includes("--die-with-parent"), "must terminate when parent exits");
});

test("cgroup unit names sanitize dangerous shell or injection characters", () => {
  const dangerousUnit = makeUnitName("task;rm -rf /;$(whoami)");
  assert.ok(!dangerousUnit.includes(";"), "must strip semicolons");
  assert.ok(!dangerousUnit.includes("$"), "must strip subshell markers");
  assert.ok(!dangerousUnit.includes(" "), "must strip whitespace");
  assert.ok(dangerousUnit.endsWith(".scope"), "must end with .scope");
});

test("docker runtime configures seccomp and no-new-privileges", () => {
  const options = workspaceSecurityOptions("/etc/ath-ide/seccomp-profile.json");
  assert.ok(options.includes("no-new-privileges"), "must disallow privilege escalation");
  assert.ok(options.some(opt => opt.startsWith("seccomp=")), "must apply seccomp profile");
  assert.throws(() => workspaceSecurityOptions("relative/path.json"), /absolute.*seccomp profile path/);
});

// ---------------------------------------------------------------------------
// 2. Filesystem Isolation & Path Traversal Defense
// ---------------------------------------------------------------------------

test("workspace paths cannot escape the assigned root via directory traversal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ath-sec-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "ath-sec-outside-"));

  try {
    await mkdir(path.join(root, "src"));
    await assert.rejects(
      resolveWorkspacePaths(root, outside),
      /escapes the assigned workspace/,
      "must reject directory outside workspace"
    );

    // Symlink escape attempt
    await symlink(outside, path.join(root, "escape-link"));
    await assert.rejects(
      resolveWorkspacePaths(root, path.join(root, "escape-link")),
      /escapes the assigned workspace/,
      "must reject symlink pointing outside workspace"
    );

    // Valid path inside workspace
    const valid = await resolveWorkspacePaths(root, path.join(root, "src"));
    assert.equal(valid.workingDirectory, "/workspace/src");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Network Egress Restrictions
// ---------------------------------------------------------------------------

test("network policy enforces lockdown for untrusted/repo-agent tasks", () => {
  assert.equal(workspaceNetworkName("repo-agent-abc123"), "none");
  assert.equal(workspaceNetworkName("user-workspace", "none"), "none");
});

test("bubblewrap rejects invalid or unapproved network modes", () => {
  assert.throws(() => {
    buildBubblewrapArgs({
      workspaceRoot: "/workspace",
      workingDirectory: "/workspace",
      command: "ls",
      networkMode: "public-egress",
    });
  }, /LINUX_SANDBOX_NETWORK must be 'none' or 'host'/);
});

// ---------------------------------------------------------------------------
// 4. Policy Engine: Command & File Denial
// ---------------------------------------------------------------------------

test("policy engine rejects destructive and hostile shell commands (DENY)", () => {
  const hostileCommands = [
    "rm -rf /",
    "rm -rf /workspace/..",
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda",
    ":(){ :|:& };:", // forkbomb
    "git reset --hard HEAD~10",
    "git push origin main --force",
    "chmod -R 777 /",
    "cat /var/run/docker.sock",
    "cat .env",
    "cat /etc/shadow",
  ];

  for (const cmd of hostileCommands) {
    const decision = classifyCommandForPolicy(cmd);
    assert.equal(decision, "DENY", `Command '${cmd}' must be DENY`);
  }
});

test("policy engine rejects access to secret files (DENY)", () => {
  const secretFiles = [
    ".env",
    ".env.production",
    ".env.local",
    "id_rsa",
    "id_ed25519",
    "server.key",
    "cert.pem",
    ".aws/credentials",
    "terraform.tfstate",
    "/etc/shadow",
    "/proc/self/environ",
  ];

  for (const file of secretFiles) {
    assert.equal(classifyFileOperationForPolicy("read", file), "DENY", `Reading '${file}' must be DENY`);
    assert.equal(classifyFileOperationForPolicy("write", file), "DENY", `Writing '${file}' must be DENY`);
  }
});

// ---------------------------------------------------------------------------
// 5. Secret Protection & Real-Time Output Redaction
// ---------------------------------------------------------------------------

test("secret sanitizer scrubs credentials before reaching agent context", () => {
  const leakSample = [
    "Error connecting to postgresql://admin:P@ssword123@db.example.com:5432/prod",
    "GitHub auth failure: ghp_9876543210zyxwvutsrqponmlkjihgfedcba",
    "Loaded AWS key: AKIAIOSFODNN7EXAMPLE",
    "OpenAI token sk-proj-1234567890abcdef1234567890abcdef",
  ].join("\n");

  const sanitized = sanitizeSecrets(leakSample);
  assert.ok(!sanitized.includes("P@ssword123"));
  assert.ok(!sanitized.includes("ghp_9876543210"));
  assert.ok(!sanitized.includes("AKIAIOSFODNN7EXAMPLE"));
  assert.ok(!sanitized.includes("sk-proj-1234567890"));
  assert.ok(sanitized.includes("[REDACTED_SECRET]"));
  assert.ok(sanitized.includes("[REDACTED_GITHUB_TOKEN]"));
  assert.ok(sanitized.includes("[REDACTED_AWS_ACCESS_KEY]"));
  assert.ok(sanitized.includes("[REDACTED_OPENAI_KEY]"));
});
