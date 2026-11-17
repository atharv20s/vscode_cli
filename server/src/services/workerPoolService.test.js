import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkerPoolService } from "./workerPoolService.js";

test("registers workers and selects the least loaded worker", () => {
  const pool = new WorkerPoolService();
  pool.registerWorker({ workerId: "w1", maxTasks: 4 });
  pool.registerWorker({ workerId: "w2", maxTasks: 4 });

  const assigned1 = pool.assignWorker("task-1", "tenant-a");
  assert.equal(assigned1.id, "w1");

  // Next task should pick w2 (least loaded)
  const assigned2 = pool.assignWorker("task-2", "tenant-a");
  assert.equal(assigned2.id, "w2");
});

test("enforces per-tenant concurrency limits", () => {
  const pool = new WorkerPoolService({ maxConcurrentPerTenant: 2 });
  pool.registerWorker({ workerId: "w1", maxTasks: 10 });

  pool.assignWorker("t1", "user-1");
  pool.assignWorker("t2", "user-1");

  assert.throws(() => {
    pool.assignWorker("t3", "user-1");
  }, /maximum concurrent worker tasks/);
});

test("detects stale workers and orphans their in-flight tasks for recovery", () => {
  const pool = new WorkerPoolService({ heartbeatTtlMs: 50 });
  pool.registerWorker({ workerId: "w1", maxTasks: 4 });

  pool.assignWorker("task-lost", "user-a");
  assert.equal(pool.tasks.get("task-lost").status, "running");

  // Force heartbeat to expire
  pool.workers.get("w1").lastHeartbeat = Date.now() - 1000;

  const orphaned = pool.pruneStaleWorkers();
  assert.equal(orphaned.length, 1);
  assert.equal(orphaned[0].id, "task-lost");
  assert.equal(orphaned[0].status, "orphaned");
  assert.equal(pool.workers.get("w1").status, "dead");
});

test("releases worker capacity when task completes", () => {
  const pool = new WorkerPoolService();
  pool.registerWorker({ workerId: "w1", maxTasks: 1 });

  const assigned = pool.assignWorker("t1", "u1");
  assert.ok(assigned);

  // Capacity full
  assert.equal(pool.assignWorker("t2", "u1"), null);

  // Complete task
  assert.equal(pool.completeTask("t1"), true);
  assert.equal(pool.tasks.get("t1").status, "completed");

  // Now has capacity
  const assignedNext = pool.assignWorker("t2", "u1");
  assert.ok(assignedNext);
});
