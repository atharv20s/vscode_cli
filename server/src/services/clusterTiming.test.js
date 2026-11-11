import test from "node:test";
import assert from "node:assert/strict";
import { getClusterTiming } from "./clusterTiming.js";

test("uses conservative defaults", () => {
  assert.deepEqual(getClusterTiming({}), {
    heartbeatMs: 5000,
    ttlMs: 15000,
    ttlSeconds: 15,
  });
});

test("supports benchmark-specific sub-second liveness settings", () => {
  assert.deepEqual(getClusterTiming({
    REDIS_HEARTBEAT_MS: "200",
    REDIS_NODE_TTL_MS: "750",
  }), {
    heartbeatMs: 200,
    ttlMs: 750,
    ttlSeconds: 1,
  });
});

test("rejects a lease TTL that is not longer than the heartbeat", () => {
  assert.throws(
    () => getClusterTiming({ REDIS_HEARTBEAT_MS: "500", REDIS_NODE_TTL_MS: "500" }),
    /must be greater/,
  );
});

test("falls back from malformed values", () => {
  assert.equal(getClusterTiming({ REDIS_HEARTBEAT_MS: "fast" }).heartbeatMs, 5000);
});
