import Redis from "ioredis";
import crypto from "crypto";
import { config } from "../config/env.js";

const STREAM = "ath:repo-agent:jobs";
const GROUP = "ath:repo-agent:workers";
const LEASE_PREFIX = "ath:repo-agent:lease:";
const CANCEL_PREFIX = "ath:repo-agent:cancel:";

class RepoAgentQueue {
  constructor() {
    this.client = null;
    this.url = config.redisUrl || process.env.REDIS_URL || "";
  }

  async connect() {
    if (!this.url) throw new Error("REDIS_URL is required for background repository agents.");
    if (!this.client) {
      this.client = new Redis(this.url, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
        connectTimeout: 10000,
        retryStrategy: attempts => Math.min(attempts * 500, 5000),
      });
    }
    if (this.client.status === "wait") await this.client.connect();
    await this.client.ping();
    await this.ensureGroup();
    return this.client;
  }

  async ensureGroup() {
    const client = this.client;
    try {
      await client.xgroup("CREATE", STREAM, GROUP, "0", "MKSTREAM");
    } catch (error) {
      if (!String(error.message).includes("BUSYGROUP")) throw error;
    }
  }

  async enqueue(taskId, attempt = 0) {
    const client = await this.connect();
    return client.xadd(
      STREAM, "*",
      "taskId", String(taskId),
      "attempt", String(attempt),
      "enqueuedAt", new Date().toISOString()
    );
  }

  async read(consumer, blockMs = 5000) {
    const client = await this.connect();
    const response = await client.xreadgroup(
      "GROUP", GROUP, consumer,
      "COUNT", 1,
      "BLOCK", blockMs,
      "STREAMS", STREAM, ">"
    );
    if (!response || !response.length) return [];
    return response.flatMap(([stream, messages]) => messages.map(([id, fields]) => {
      const data = {};
      for (let i = 0; i < fields.length; i += 2) data[fields[i]] = fields[i + 1];
      return { stream, id, taskId: data.taskId, attempt: Number(data.attempt || 0) };
    }));
  }

  async reclaim(consumer, minIdleMs = 60000) {
    const client = await this.connect();
    const response = await client.xautoclaim(STREAM, GROUP, consumer, minIdleMs, "0-0", "COUNT", 1);
    const messages = response?.[1] || [];
    return messages.map(([id, fields]) => {
      const data = {};
      for (let i = 0; i < fields.length; i += 2) data[fields[i]] = fields[i + 1];
      return { stream: STREAM, id, taskId: data.taskId, attempt: Number(data.attempt || 0) };
    });
  }

  async ack(id) {
    if (!this.client) return;
    await this.client.xack(STREAM, GROUP, id);
  }

  async acquireLease(taskId, ttlMs = 120000) {
    const client = await this.connect();
    const token = crypto.randomUUID();
    const result = await client.set(LEASE_PREFIX + taskId, token, "PX", ttlMs, "NX");
    return result === "OK" ? token : null;
  }

  async renewLease(taskId, token, ttlMs = 120000) {
    const client = await this.connect();
    const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
    return Number(await client.eval(script, 1, LEASE_PREFIX + taskId, token, String(ttlMs))) === 1;
  }

  async ownsLease(taskId, token) {
    const client = await this.connect();
    return (await client.get(LEASE_PREFIX + taskId)) === token;
  }

  async releaseLease(taskId, token) {
    if (!this.client) return;
    const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
    await this.client.eval(script, 1, LEASE_PREFIX + taskId, token);
  }

  async requestCancellation(taskId) {
    const client = await this.connect();
    await client.set(CANCEL_PREFIX + taskId, "1", "EX", 3600);
  }

  async isCancellationRequested(taskId) {
    const client = await this.connect();
    return (await client.exists(CANCEL_PREFIX + taskId)) === 1;
  }

  async clearCancellation(taskId) {
    const client = await this.connect();
    await client.del(CANCEL_PREFIX + taskId);
  }

  async heartbeatWorker(workerId, metadata = {}) {
    const client = await this.connect();
    const value = {
      workerId,
      host: metadata.host || "",
      pid: metadata.pid || 0,
      currentTaskId: metadata.currentTaskId || null,
      updatedAt: new Date().toISOString(),
    };
    await client.set("ath:repo-agent:worker:" + workerId, JSON.stringify(value), "EX", 30);
    return value;
  }

  async unregisterWorker(workerId) {
    if (!this.client) return;
    await this.client.del("ath:repo-agent:worker:" + workerId);
  }

  async listWorkers() {
    const client = await this.connect();
    let cursor = "0";
    const keys = [];
    do {
      const result = await client.scan(cursor, "MATCH", "ath:repo-agent:worker:*", "COUNT", 100);
      cursor = result[0];
      keys.push(...result[1]);
    } while (cursor !== "0");
    if (!keys.length) return [];
    const values = await client.mget(...keys);
    return values.flatMap(value => {
      if (!value) return [];
      try { return [JSON.parse(value)]; } catch { return []; }
    });
  }

  async deadLetter(taskId, attempt, reason) {
    const client = await this.connect();
    return client.xadd(
      "ath:repo-agent:dead",
      "*",
      "taskId", String(taskId),
      "attempt", String(attempt || 0),
      "reason", String(reason || "worker failure").slice(0,3000),
      "failedAt", new Date().toISOString()
    );
  }

  async close() {
    if (this.client) {
      await this.client.quit().catch(() => {});
      this.client = null;
    }
  }

  get streamName() { return STREAM; }
}

export const repoAgentQueue = new RepoAgentQueue();
