import { test } from "node:test";
import assert from "node:assert/strict";
import { DistributedLspPool } from "./distributedLspPool.js";

test("acquires and releases LSP daemon slots within capacity limits", async () => {
  const pool = new DistributedLspPool({ nodeLimit: 2 });

  const slot1 = await pool.acquireSlot("session-1", "ws-a", "typescript");
  assert.equal(slot1.allowed, true);
  assert.ok(slot1.slotId);

  const slot2 = await pool.acquireSlot("session-2", "ws-b", "python");
  assert.equal(slot2.allowed, true);

  // Exceeds nodeLimit (2)
  const slot3 = await pool.acquireSlot("session-3", "ws-c", "typescript");
  assert.equal(slot3.allowed, false);
  assert.ok(slot3.reason.includes("maximum LSP process limit"));

  // Release a slot
  await pool.releaseSlot("session-1");
  assert.equal(pool.localDaemons.size, 1);

  // Now slot can be acquired
  const slot3Retry = await pool.acquireSlot("session-3", "ws-c", "typescript");
  assert.equal(slot3Retry.allowed, true);
});

test("touches daemons to update last activity and prevent premature eviction", async () => {
  const pool = new DistributedLspPool({ nodeLimit: 2 });
  await pool.acquireSlot("s1", "ws-1", "typescript");

  const initial = pool.localDaemons.get("s1").lastActivity;
  await new Promise(r => setTimeout(r, 10));

  pool.touch("s1");
  const touched = pool.localDaemons.get("s1").lastActivity;
  assert.ok(touched > initial);
});

test("reports accurate status metrics", async () => {
  const pool = new DistributedLspPool({ nodeLimit: 4 });
  await pool.acquireSlot("s1", "ws-1", "typescript");

  const status = pool.getStatus();
  assert.equal(status.activeCount, 1);
  assert.equal(status.nodeLimit, 4);
  assert.equal(status.daemons[0].language, "typescript");
});
