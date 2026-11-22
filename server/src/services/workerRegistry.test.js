import test from "node:test";
import assert from "node:assert/strict";
import { WorkerRegistry, normalizeWorker } from "./workerRegistry.js";

class FakeRedis {
  constructor() { this.hashes = new Map(); this.sets = new Map(); }
  async hset(key, values) { this.hashes.set(key, { ...(this.hashes.get(key) || {}), ...values }); }
  async hgetall(key) { return { ...(this.hashes.get(key) || {}) }; }
  async exists(key) { return this.hashes.has(key) ? 1 : 0; }
  async pexpire() {}
  async sadd(key, ...values) { const s=this.sets.get(key)||new Set(); values.forEach(v=>s.add(v)); this.sets.set(key,s); }
  async srem(key, ...values) { const s=this.sets.get(key)||new Set(); values.forEach(v=>s.delete(v)); }
  async smembers(key) { return [...(this.sets.get(key)||[])]; }
  async del(key) { this.hashes.delete(key); }
  async eval(script, _count, key) {
    const h=this.hashes.get(key); if (!h) return 0;
    if (script.includes("HINCRBY") && script.includes("capacity")) {
      if (h.status !== "healthy" || Number(h.active) >= Number(h.capacity)) return 0;
      h.active=String(Number(h.active)+1); return 1;
    }
    if (Number(h.active) <= 0) return 0;
    h.active=String(Number(h.active)-1); return 1;
  }
}

test("worker endpoints reject non-TLS remote URLs and unsafe capacities", () => {
  assert.throws(() => normalizeWorker({ workerId:"worker-001", endpoint:"http://worker.example", capacity:2 }), /HTTPS/);
  assert.throws(() => normalizeWorker({ workerId:"worker-001", endpoint:"https://worker.example", capacity:0 }), /capacity/);
  assert.equal(normalizeWorker({ workerId:"worker-001", endpoint:"https://worker.example", capacity:2 }).workerId, "worker-001");
});

test("registry uses expiring leases and removes crashed workers from discovery", async () => {
  const redis=new FakeRedis(); const registry=new WorkerRegistry(redis);
  await registry.register({ workerId:"worker-001", endpoint:"https://worker.example", capacity:2, region:"ap-south-1" });
  assert.equal((await registry.list({ region:"ap-south-1" })).length,1);
  await redis.del("ath:workers:v1:worker-001");
  assert.deepEqual(await registry.list(),[]);
});

test("capacity reservations are atomic and never exceed the configured limit", async () => {
  const registry=new WorkerRegistry(new FakeRedis());
  await registry.register({ workerId:"worker-001", endpoint:"https://worker.example", capacity:1 });
  assert.equal(await registry.reserve("worker-001"),true);
  assert.equal(await registry.reserve("worker-001"),false);
  assert.equal(await registry.release("worker-001"),true);
  assert.equal(await registry.release("worker-001"),false);
});

test("draining workers stop accepting new reservations", async () => {
  const registry=new WorkerRegistry(new FakeRedis());
  await registry.register({ workerId:"worker-001", endpoint:"https://worker.example", capacity:2 });
  assert.equal(await registry.markDraining("worker-001"),true);
  assert.equal(await registry.reserve("worker-001"),false);
});
