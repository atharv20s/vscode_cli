/**
 * Distributed & In-Memory Cache Service
 *
 * Tier 1: Redis (if Docker / Redis is running on localhost:6379)
 * Tier 2: In-memory node-cache (zero-config fallback)
 *
 * Uses SHA-256 key hashing with TTL support and hit/miss metrics.
 */

import NodeCache from "node-cache";
import Redis from "ioredis";
import crypto from "crypto";
import { logger } from "../config/logger.js";

// Local in-memory cache
const localCache = new NodeCache({
  stdTTL: 300,
  checkperiod: 60,
  useClones: false,
});

// Redis client (optional)
let redisClient = null;
if (process.env.REDIS_URL && process.env.REDIS_URL !== "redis://localhost:6379") {
  try {
    redisClient = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null, // Don't spam retries if redis is not running
      enableOfflineQueue: false,
    });

    redisClient.on("error", () => {
      redisClient = null;
    });

    redisClient
      .connect()
      .then(() => logger.info("⚡ Connected to Redis Cache on " + redisUrl))
      .catch(() => {
        redisClient = null;
      });
  } catch {
    redisClient = null;
  }
} else {
  redisClient = null;
}

// Metrics
let hits = 0;
let misses = 0;

/**
 * Generate a cache key from namespace and payload.
 */
export function cacheKey(namespace, data) {
  const hash = crypto
    .createHash("sha256")
    .update(typeof data === "string" ? data : JSON.stringify(data))
    .digest("hex")
    .slice(0, 16);
  return `${namespace}:${hash}`;
}

/**
 * Get a cached value (checks Redis first, then local cache).
 */
export async function cacheGet(key) {
  if (redisClient && redisClient.status === "ready") {
    try {
      const raw = await redisClient.get(key);
      if (raw !== null) {
        hits++;
        return JSON.parse(raw);
      }
    } catch {}
  }

  const value = localCache.get(key);
  if (value !== undefined) {
    hits++;
    return value;
  }

  misses++;
  return undefined;
}

/**
 * Set a cached value with TTL.
 */
export async function cacheSet(key, value, ttlSeconds = 300) {
  localCache.set(key, value, ttlSeconds);

  if (redisClient && redisClient.status === "ready") {
    try {
      await redisClient.set(key, JSON.stringify(value), "EX", ttlSeconds);
    } catch {}
  }
}

/**
 * Delete a cached value.
 */
export async function cacheDel(key) {
  localCache.del(key);
  if (redisClient && redisClient.status === "ready") {
    try {
      await redisClient.del(key);
    } catch {}
  }
}

/**
 * Flush all cache entries.
 */
export async function cacheFlush() {
  localCache.flushAll();
  if (redisClient && redisClient.status === "ready") {
    try {
      await redisClient.flushdb();
    } catch {}
  }
  logger.info("Cache flushed");
}

/**
 * Get cache metrics.
 */
export function cacheMetrics() {
  const total = hits + misses;
  return {
    hits,
    misses,
    hitRate: total > 0 ? `${((hits / total) * 100).toFixed(1)}%` : "0.0%",
    driver: redisClient && redisClient.status === "ready" ? "Redis + In-Memory" : "In-Memory",
    keys: localCache.keys().length,
  };
}

/**
 * Get-or-compute decorator pattern.
 */
export async function cachedCompute(key, computeFn, ttlSeconds = 300) {
  const existing = await cacheGet(key);
  if (existing !== undefined) {
    return existing;
  }

  const value = await computeFn();
  await cacheSet(key, value, ttlSeconds);
  return value;
}
