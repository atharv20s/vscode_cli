import test from "node:test";
import assert from "node:assert/strict";
import { buildBubblewrapArgs, makeUnitName, LinuxSandboxBackend, resolveWorkspacePaths } from "./linuxSandboxBackend.js";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("builds an isolated namespace command with network disabled by default", () => {
  const args = buildBubblewrapArgs({
    workspaceRoot: "/srv/workspaces/user-a",
    workingDirectory: "/workspace/project",
    command: "npm test",
    systemPaths: ["/usr", "/bin"],
    etcFiles: [],
  });
  assert.ok(args.includes("--unshare-user"));
  assert.ok(args.includes("--unshare-pid"));
  assert.ok(args.includes("--unshare-net"));
  assert.ok(!args.includes("--share-net"));
  assert.ok(args.includes("--clearenv"));
  assert.ok(!args.includes("/etc/shadow"));
  assert.ok(!args.includes("--ro-bind") || !args.includes("/etc"));
  assert.ok(args.includes("/srv/workspaces/user-a"));
  assert.ok(args.includes("npm test"));
});

test("host networking is an explicit, validated administrator setting", () => {
  const args = buildBubblewrapArgs({
    workspaceRoot: "/workspace",
    workingDirectory: "/workspace",
    command: "npm install",
    networkMode: "host",
    systemPaths: [],
  });
  assert.ok(args.includes("--share-net"));
  assert.ok(!args.includes("--unshare-net"));
  assert.throws(() => buildBubblewrapArgs({ workspaceRoot: "/workspace", workingDirectory: "/workspace", command: "true", networkMode: "public" }), /LINUX_SANDBOX_NETWORK/);
});

test("unit names cannot contain arbitrary shell or systemd syntax", () => {
  assert.equal(makeUnitName("task/$(id);bad"), "athide-task---id--bad.scope");
});

test("workspace cwd must resolve inside the assigned workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ath-linux-sandbox-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "ath-linux-outside-"));
  try {
    await mkdir(path.join(root, "project"));
    await assert.rejects(resolveWorkspacePaths(root, outside), /escapes the assigned workspace/);
    const resolved = await resolveWorkspacePaths(root, path.join(root, "project"));
    assert.equal(resolved.workingDirectory, "/workspace/project");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("non-Linux hosts fail closed before spawning", async () => {
  const backend = new LinuxSandboxBackend({ platform: "win32", spawnProcess: () => { throw new Error("must not spawn"); } });
  await assert.rejects(backend.execute({ command: "id", workspaceDir: "/tmp" }), /requires a Linux worker/);
});
