import crypto from "node:crypto";

const WORKER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,95}$/;
const DEFAULT_TTL_MS = 15000;
const MAX_TTL_MS = 120000;

function validCapacity(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 256;
}

function normalizeWorker(input) {
  if (!input || typeof input !== "object" || !WORKER_ID.test(input.workerId || "")) {
    throw new Error("A valid workerId is required.");
  }
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1"].includes(endpoint.hostname))) {
    throw new Error("Worker endpoints must use HTTPS (HTTP is allowed only for loopback).");
  }
  if (!validCapacity(input.capacity)) throw new Error("Worker capacity must be an integer from 1 to 256.");
  const region = String(input.region || "default").slice(0, 64);
  return { workerId: input.workerId, endpoint: endpoint.toString(), region, capacity: input.capacity };
}

const claimScript = `
local status = redis.call('HGET', KEYS[1], 'status')
if status ~= 'healthy' then return 0 end
local active = tonumber(redis.call('HGET', KEYS[1], 'active') or '0')
local capacity = tonumber(redis.call('HGET', KEYS[1], 'capacity') or '0')
if active >= capacity then return 0 end
redis.call('HINCRBY', KEYS[1], 'active', 1)
return 1
`;

const releaseScript = `
local active = tonumber(redis.call('HGET', KEYS[1], 'active') or '0')
if active <= 0 then return 0 end
redis.call('HINCRBY', KEYS[1], 'active', -1)
return 1
`;

/**
 * Redis-backed execution-worker registry.
 *
 * Worker records are short-lived leases: a crashed worker disappears when its
 * heartbeat expires. Capacity reservations are atomic Lua operations, so two
 * API instances cannot over-allocate the same worker.
 */
export class WorkerRegistry {
  constructor(redis, { ttlMs = DEFAULT_TTL_MS, keyPrefix = "ath:workers:v1" } = {}) {
    if (!redis || typeof redis.hset !== "function" || typeof redis.eval !== "function") {
      throw new Error("A Redis client supporting hashes and Lua eval is required.");
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 3000 || ttlMs > MAX_TTL_MS) {
      throw new Error("Worker lease TTL must be between 3000 and 120000 ms.");
    }
    this.redis = redis;
    this.ttlMs = ttlMs;
    this.keyPrefix = keyPrefix;
    this.instanceId = crypto.randomUUID();
  }

  key(workerId) {
    if (!WORKER_ID.test(workerId || "")) throw new Error("Invalid worker identity.");
    return `${this.keyPrefix}:${workerId}`;
  }

  async register(input) {
    const worker = normalizeWorker(input);
    const key = this.key(worker.workerId);
    const now = Date.now();
    await this.redis.hset(key, {
      ...worker,
      active: "0",
      status: "healthy",
      registeredAt: String(now),
      lastHeartbeat: String(now),
      generation: crypto.randomUUID(),
    });
    await this.redis.pexpire(key, this.ttlMs);
    await this.redis.sadd(`${this.keyPrefix}:index`, worker.workerId);
    return this.get(worker.workerId);
  }

  async heartbeat(workerId, { status = "healthy" } = {}) {
    if (!["healthy", "draining"].includes(status)) throw new Error("Invalid worker status.");
    const key = this.key(workerId);
    const exists = await this.redis.exists(key);
    if (!exists) return false;
    await this.redis.hset(key, { status, lastHeartbeat: String(Date.now()) });
    await this.redis.pexpire(key, this.ttlMs);
    return true;
  }

  async get(workerId) {
    const record = await this.redis.hgetall(this.key(workerId));
    if (!record || !record.workerId) return null;
    return {
      workerId: record.workerId,
      endpoint: record.endpoint,
      region: record.region,
      capacity: Number(record.capacity),
      active: Number(record.active),
      status: record.status,
      registeredAt: Number(record.registeredAt),
      lastHeartbeat: Number(record.lastHeartbeat),
      generation: record.generation,
    };
  }

  async list({ region } = {}) {
    const index = `${this.keyPrefix}:index`;
    const ids = await this.redis.smembers(index);
    const workers = await Promise.all(ids.map(id => this.get(id)));
    const live = workers.filter(Boolean);
    const stale = ids.filter((id, i) => !workers[i]);
    if (stale.length) await this.redis.srem(index, ...stale);
    return live.filter(worker => !region || worker.region === region);
  }

  async reserve(workerId) {
    const result = await this.redis.eval(claimScript, 1, this.key(workerId));
    return Number(result) === 1;
  }

  async release(workerId) {
    const result = await this.redis.eval(releaseScript, 1, this.key(workerId));
    return Number(result) === 1;
  }

  async markDraining(workerId) {
    return this.heartbeat(workerId, { status: "draining" });
  }

  async unregister(workerId) {
    const key = this.key(workerId);
    await this.redis.del(key);
    await this.redis.srem(`${this.keyPrefix}:index`, workerId);
  }

  async shutdown() {
    // Registry instances do not own the shared Redis connection.
  }
}

export { normalizeWorker };
