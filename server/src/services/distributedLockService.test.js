import { test } from "node:test";
import assert from "node:assert/strict";
import { DistributedLockService } from "./distributedLockService.js";

test("acquires and releases distributed lock with token verification", async () => {
  const service = new DistributedLockService();
  const res = "workspace:test-1";

  const lock1 = await service.acquire(res, 5000);
  assert.equal(lock1.acquired, true);
  assert.ok(lock1.token);

  // Second acquisition attempt must fail while held
  const lock2 = await service.acquire(res, 5000);
  assert.equal(lock2.acquired, false);

  // Releasing with wrong token must fail
  const releasedWrong = await service.release(res, "wrong-token-123");
  assert.equal(releasedWrong, false);

  // Releasing with correct token succeeds
  const released = await service.release(res, lock1.token);
  assert.equal(released, true);

  // Now lock can be acquired again
  const lock3 = await service.acquire(res, 5000);
  assert.equal(lock3.acquired, true);
  await service.release(res, lock3.token);
});

test("locks automatically expire after TTL to prevent deadlocks", async () => {
  const service = new DistributedLockService({ defaultTtlMs: 50 });
  const res = "workspace:ttl-test";

  const lock1 = await service.acquire(res, 50);
  assert.equal(lock1.acquired, true);

  // Wait for TTL expiration
  await new Promise(r => setTimeout(r, 80));

  // Lock should be freely acquirable again without explicit release
  const lock2 = await service.acquire(res, 50);
  assert.equal(lock2.acquired, true);
  await service.release(res, lock2.token);
});

test("extends active lease duration", async () => {
  const service = new DistributedLockService();
  const res = "workspace:extend-test";

  const lock = await service.acquire(res, 1000);
  assert.equal(lock.acquired, true);

  const extended = await service.extend(res, lock.token, 5000);
  assert.equal(extended, true);

  const failExtend = await service.extend(res, "bad-token", 5000);
  assert.equal(failExtend, false);

  await service.release(res, lock.token);
});
