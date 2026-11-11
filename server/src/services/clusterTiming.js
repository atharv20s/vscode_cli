/**
 * Redis cluster liveness timing.
 *
 * Defaults preserve the existing conservative production behavior. Faster values
 * are intended for controlled fault-injection runs and must be validated against
 * Redis/network jitter before production use.
 */
function positiveInt(name, value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function getClusterTiming(env = process.env) {
  const heartbeatMs = positiveInt("REDIS_HEARTBEAT_MS", env.REDIS_HEARTBEAT_MS, 5000);
  const defaultTtlMs = heartbeatMs * 3;
  const ttlMs = positiveInt("REDIS_NODE_TTL_MS", env.REDIS_NODE_TTL_MS, defaultTtlMs);
  if (ttlMs <= heartbeatMs) {
    throw new Error("REDIS_NODE_TTL_MS must be greater than REDIS_HEARTBEAT_MS");
  }
  return Object.freeze({ heartbeatMs, ttlMs, ttlSeconds: Math.ceil(ttlMs / 1000) });
}
