import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { parseByteLimit, parseCpuMax, parsePidsLimit, parseCgroupMembership, getLinuxRuntimeDiagnostics } from "./linuxRuntimeService.js";

test("parses cgroup v2 membership without losing nested paths", () => {
  assert.deepEqual(parseCgroupMembership("0::/user.slice/user-1000.slice/session-2.scope\n"), [
    { hierarchy: "0", controllers: [], path: "/user.slice/user-1000.slice/session-2.scope" },
  ]);
});

test("parses finite and unlimited cgroup limits", () => {
  assert.equal(parseByteLimit("536870912\n"), 536870912);
  assert.equal(parseByteLimit("max\n"), null);
  assert.equal(parseCpuMax("150000 100000"), 1.5);
  assert.equal(parseCpuMax("max 100000"), null);
  assert.equal(parseCpuMax("invalid"), null);
  assert.equal(parsePidsLimit("128"), 128);
  assert.equal(parsePidsLimit("max"), null);
  assert.equal(parsePidsLimit(""), null);
});

test("returns a stable unsupported result outside Linux", async () => {
  assert.deepEqual(await getLinuxRuntimeDiagnostics({ platform: "win32" }), {
    supported: false, platform: "win32", reason: "Linux runtime diagnostics require a Linux worker.",
  });
});

test("reads only process-scoped procfs and cgroup fixture data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ath-linux-runtime-"));
  const proc = path.join(root, "proc");
  const cgroup = path.join(root, "cgroup");
  const scope = path.join(cgroup, "user.slice", "session.scope");
  try {
    await mkdir(path.join(proc, "sys/kernel"), { recursive: true });
    await mkdir(path.join(proc, "self/ns"), { recursive: true });
    await mkdir(scope, { recursive: true });
    await writeFile(path.join(proc, "sys/kernel/osrelease"), "6.8.0-test\n");
    await writeFile(path.join(proc, "self/cgroup"), "0::/user.slice/session.scope\n");
    await writeFile(path.join(proc, "self/status"), "Seccomp:\t2\nNoNewPrivs:\t1\n");
    await writeFile(path.join(cgroup, "cgroup.controllers"), "cpu memory pids");
    await writeFile(path.join(scope, "memory.max"), "268435456");
    await writeFile(path.join(scope, "cpu.max"), "50000 100000");
    await writeFile(path.join(scope, "pids.max"), "128");
    const result = await getLinuxRuntimeDiagnostics({ platform: "linux", procRoot: proc, cgroupRoot: cgroup });
    assert.equal(result.supported, true);
    assert.equal(result.kernel.release, "6.8.0-test");
    assert.equal(result.isolation.cgroupVersion, 2);
    assert.equal(result.isolation.seccompMode, 2);
    assert.equal(result.isolation.noNewPrivileges, true);
    assert.equal(result.limits.memoryBytes, 268435456);
    assert.equal(result.limits.cpuCores, 0.5);
    assert.equal(result.limits.processCount, 128);
    assert.equal(result.isolation.namespaces.mnt, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
