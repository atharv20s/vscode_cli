import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { config } from "../../config/env.js";
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
    await symlink(outside, path.join(root, "linked"));
    await assert.rejects(resolveWorkspacePaths(root, path.join(root, "linked")), /escapes the assigned workspace/);
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

test("executes through systemd-run with a sanitized environment and cgroup limits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ath-linux-exec-"));
  const calls = [];
  const original = { ...config.linuxSandbox };
  try {
    await mkdir(path.join(root, "src"));
    config.linuxSandbox.systemdRunBinary = "/usr/bin/systemd-run";
    config.linuxSandbox.systemctlBinary = "/usr/bin/systemctl";
    config.linuxSandbox.bubblewrapBinary = "/usr/bin/bwrap";
    config.linuxSandbox.memoryMax = "512M";
    config.linuxSandbox.cpuQuota = "100%";
    config.linuxSandbox.tasksMax = 64;
    config.linuxSandbox.networkMode = "none";
    config.linuxSandbox.maxOutputBytes = 4096;
    const fakeSpawn = (binary, args, options) => {
      calls.push({ binary, args, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      if (binary === config.linuxSandbox.systemdRunBinary) {
        queueMicrotask(() => {
          child.stdout.write("sandbox ok");
          child.emit("close", 0);
        });
      }
      return child;
    };
    const backend = new LinuxSandboxBackend({ platform: "linux", spawnProcess: fakeSpawn, fsAccess: async () => {} });
    const result = await backend.execute({
      workspaceId: "user-a:workspace-1",
      workspaceDir: root,
      cwd: path.join(root, "src"),
      command: "npm test",
      timeout: 5000,
      operationId: "test-op",
    });
    assert.equal(result.success, true);
    assert.equal(result.output, "sandbox ok");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].binary, "/usr/bin/systemd-run");
    assert.ok(calls[0].args.includes("--property=MemoryMax=512M"));
    assert.ok(calls[0].args.includes("--property=CPUQuota=100%"));
    assert.ok(calls[0].args.includes("--property=TasksMax=64"));
    assert.ok(calls[0].args.includes("--unshare-net"));
    assert.deepEqual(calls[0].options.env, { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", TERM: "dumb" });
  } finally {
    Object.assign(config.linuxSandbox, original);
    await rm(root, { recursive: true, force: true });
  }
});
