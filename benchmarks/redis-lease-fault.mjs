import Redis from "ioredis";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error("Set REDIS_URL to a disposable Redis instance");
const heartbeatMs = Number(process.env.REDIS_HEARTBEAT_MS || 200);
const ttlMs = Number(process.env.REDIS_NODE_TTL_MS || 750);
if (!Number.isInteger(heartbeatMs) || heartbeatMs <= 0 || !Number.isInteger(ttlMs) || ttlMs <= heartbeatMs) {
  throw new Error("Require positive REDIS_HEARTBEAT_MS and REDIS_NODE_TTL_MS > heartbeat interval");
}
const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
const key = `ath:benchmark:lease:${randomUUID()}`;
let timer;
try {
  await redis.set(key, "alive", "PX", ttlMs);
  const started = performance.now();
  // Simulate abrupt worker death: no further heartbeat renewals are issued.
  const expiry = new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const exists = await redis.exists(key);
        if (!exists) return resolve(performance.now() - started);
        timer = setTimeout(poll, Math.min(25, heartbeatMs));
      } catch (error) { reject(error); }
    };
    poll();
  });
  const observedMs = await expiry;
  console.log(JSON.stringify({
    benchmark: "redis-lease-expiry-fault-injection",
    heartbeatMs,
    configuredTtlMs: ttlMs,
    observedExpiryMs: Number(observedMs.toFixed(3)),
    note: "Measures lease expiry only; does not prove worker job reassignment or loss/duplication guarantees.",
  }, null, 2));
} finally {
  clearTimeout(timer);
  await redis.del(key).catch(() => {});
  await redis.quit();
}
