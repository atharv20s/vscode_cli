import test from "node:test";
import assert from "node:assert/strict";
import { parseCgroupStats, parseCgroupPressure, readCgroupV2Metrics } from "./cgroupMetrics.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("parses cgroup v2 counters", () => {
  assert.deepEqual(parseCgroupStats("usage_usec 123456789\nnr_periods 42\n"), {
    usage_usec: 123456789, nr_periods: 42,
  });
});

test("parses CPU and memory pressure stall information", () => {
  assert.deepEqual(parseCgroupPressure("some avg10=0.25 avg60=0.10 avg300=0.02 total=900"), {
    some: { avg10: 0.25, avg60: 0.1, avg300: 0.02, total: 900 },
  });
});

test("reads cgroup v2 limits and usage from the process cgroup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ath-cgroup-metrics-"));
  const proc = path.join(root, "proc"), cg = path.join(root, "cgroup");
  const scope = path.join(cg, "user.slice", "worker.scope");
  try {
    await mkdir(path.join(proc, "self"), { recursive: true });
    await mkdir(scope, { recursive: true });
    await writeFile(path.join(proc, "self/cgroup"), "0::/user.slice/worker.scope\n");
    await writeFile(path.join(scope, "memory.current"), "134217728");
    await writeFile(path.join(scope, "memory.max"), "536870912");
    await writeFile(path.join(scope, "cpu.stat"), "usage_usec 1000000\n");
    await writeFile(path.join(scope, "cpu.max"), "100000 100000");
    await writeFile(path.join(scope, "pids.current"), "12");
    await writeFile(path.join(scope, "pids.max"), "128");
    await writeFile(path.join(scope, "memory.events"), "oom 0\noom_kill 0\n");
    await writeFile(path.join(scope, "cpu.pressure"), "some avg10=0.1 avg60=0.2 avg300=0.3 total=4");
    const result = await readCgroupV2Metrics({ platform: "linux", procRoot: proc, cgroupRoot: cg });
    assert.equal(result.memoryUsedBytes, 134217728);
    assert.equal(result.memoryLimitBytes, 536870912);
    assert.equal(result.cpuUsageUsec, 1000000);
    assert.equal(result.cpuLimitCores, 1);
    assert.equal(result.processCount, 12);
    assert.equal(result.processLimit, 128);
    assert.equal(result.memoryEvents.oom_kill, 0);
    assert.equal(result.pressure.cpu.some.avg10, 0.1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns null when cgroup v2 is unavailable", async () => {
  assert.equal(await readCgroupV2Metrics({ platform: "win32" }), null);
});
