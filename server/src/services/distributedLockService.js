/**
 * Distributed Lock Service (Milestone 2.0 / PR #67)
 *
 * Implements TTL-based distributed leasing across workspaces:
 * - Redis-backed locking when Redis is configured
 * - High-precision in-memory fallback for standalone/local dev
 * - Automatic lease expiry to prevent deadlocks on worker failure
 * - Atomic compare-and-release (fencing token verification)
 * - Lease extension for long-running agent tasks
 */

import crypto from "crypto";
import { logger } from "../config/logger.js";

const DEFAULT_LEASE_TTL_MS = 30_000;

export class DistributedLockService {
  constructor(options = {}) {
    this.redisClient = options.redisClient || null;
    this.defaultTtlMs = options.defaultTtlMs || DEFAULT_LEASE_TTL_MS;
    // In-memory fallback map: key -> { token, expiresAt, timer }
    this._localLocks = new Map();
  }

  /**
   * Acquire a distributed lock.
   *
   * @param {string} resourceKey - e.g. "workspace:user-123"
   * @param {number} [ttlMs] - Lease duration in milliseconds
   * @returns {Promise<{ acquired: boolean, token: string|null, expiresAt: number }>}
   */
  async acquire(resourceKey, ttlMs = this.defaultTtlMs) {
    if (!resourceKey || typeof resourceKey !== "string") throw new Error("A valid resourceKey is required.");
    const token = crypto.randomUUID();
    const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : this.defaultTtlMs;

    if (this.redisClient && this.redisClient.status === "ready") {
      try {
        const key = `lock:${resourceKey}`;
        // Redis SET key token PX ttl NX
        const result = await this.redisClient.set(key, token, "PX", ttl, "NX");
        if (result === "OK") {
          return { acquired: true, token, expiresAt: Date.now() + ttl };
        }
        return { acquired: false, token: null, expiresAt: 0 };
      } catch (err) {
        logger.warn(`Redis lock acquisition failed for ${resourceKey}, falling back to local`, { error: err.message });
      }
    }

    // In-memory fallback
    const now = Date.now();
    const existing = this._localLocks.get(resourceKey);
    if (existing && existing.expiresAt > now) {
      return { acquired: false, token: null, expiresAt: 0 };
    }

    const expiresAt = now + ttl;
    const timer = setTimeout(() => {
      const current = this._localLocks.get(resourceKey);
      if (current && current.token === token) {
        this._localLocks.delete(resourceKey);
      }
    }, ttl);

    this._localLocks.set(resourceKey, { token, expiresAt, timer });
    return { acquired: true, token, expiresAt };
  }

  /**
   * Release lock atomically using fencing token.
   */
  async release(resourceKey, token) {
    if (!resourceKey || !token) return false;

    if (this.redisClient && this.redisClient.status === "ready") {
      try {
        const key = `lock:${resourceKey}`;
        // Lua script: if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end
        const lua = `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;
        const result = await this.redisClient.eval(lua, 1, key, token);
        return result === 1;
      } catch (err) {
        logger.warn(`Redis lock release failed for ${resourceKey}`, { error: err.message });
      }
    }

    // Local fallback
    const existing = this._localLocks.get(resourceKey);
    if (!existing) return false;
    if (existing.token !== token) return false; // Fencing check failed!

    clearTimeout(existing.timer);
    this._localLocks.delete(resourceKey);
    return true;
  }

  /**
   * Extend lease duration for an active lock.
   */
  async extend(resourceKey, token, extraTtlMs = this.defaultTtlMs) {
    if (!resourceKey || !token) return false;
    const extra = Number(extraTtlMs) > 0 ? Number(extraTtlMs) : this.defaultTtlMs;

    if (this.redisClient && this.redisClient.status === "ready") {
      try {
        const key = `lock:${resourceKey}`;
        const lua = `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("pexpire",KEYS[1],ARGV[2]) else return 0 end`;
        const result = await this.redisClient.eval(lua, 1, key, token, extra);
        return result === 1;
      } catch (err) {
        logger.warn(`Redis lock extend failed for ${resourceKey}`, { error: err.message });
      }
    }

    // Local fallback
    const existing = this._localLocks.get(resourceKey);
    if (!existing || existing.token !== token) return false;

    clearTimeout(existing.timer);
    existing.expiresAt = Date.now() + extra;
    existing.timer = setTimeout(() => {
      const current = this._localLocks.get(resourceKey);
      if (current && current.token === token) {
        this._localLocks.delete(resourceKey);
      }
    }, extra);

    return true;
  }

  /**
   * Query lock state.
   */
  isLocked(resourceKey) {
    const existing = this._localLocks.get(resourceKey);
    return Boolean(existing && existing.expiresAt > Date.now());
  }
}

export const distributedLockService = new DistributedLockService();
