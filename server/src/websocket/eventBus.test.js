import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { EventBus, REDIS_EVENT_CHANNEL } from "./eventBus.js";

class FakeRedis extends EventEmitter {
  static clients = new Set();

  constructor() {
    super();
    this.status = "wait";
    this.channel = null;
    FakeRedis.clients.add(this);
  }

  duplicate() {
    return new FakeRedis();
  }

  async connect() {
    this.status = "ready";
    return "OK";
  }

  async subscribe(channel) {
    this.channel = channel;
    return 1;
  }

  async publish(channel, message) {
    for (const client of FakeRedis.clients) {
      if (client.status === "ready" && client.channel === channel) {
        client.emit("message", channel, message);
      }
    }
    return 1;
  }

  async quit() {
    this.status = "end";
    FakeRedis.clients.delete(this);
    return "OK";
  }

  static reset() {
    for (const client of FakeRedis.clients) client.removeAllListeners();
    FakeRedis.clients.clear();
  }
}

test("Redis fan-out delivers an event once to each replica and suppresses publisher echo", async () => {
  FakeRedis.reset();
  const replicaA = new EventBus({ RedisClass: FakeRedis });
  const replicaB = new EventBus({ RedisClass: FakeRedis });
  await replicaA.initialize({ redisUrl: "redis://test" });
  await replicaB.initialize({ redisUrl: "redis://test" });

  let aCount = 0;
  let bCount = 0;
  replicaA.subscribe("file.changed", () => aCount++);
  replicaB.subscribe("file.changed", () => bCount++);

  const envelope = replicaA.publish("file.changed", { path: "src/index.js" }, {
    workspaceId: "tenant-hash:default",
    source: "ui",
    actor: "user",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(aCount, 1);
  assert.equal(bCount, 1);
  assert.equal(envelope.workspaceId, "tenant-hash:default");
  assert.equal(replicaA.getDistributedStatus().enabled, true);
  assert.equal(replicaB.getDistributedStatus().channel, REDIS_EVENT_CHANNEL);

  await replicaA.shutdown();
  await replicaB.shutdown();
  FakeRedis.reset();
});

test("malformed Redis events are ignored", async () => {
  FakeRedis.reset();
  const bus = new EventBus({ RedisClass: FakeRedis });
  await bus.initialize({ redisUrl: "redis://test" });
  let received = 0;
  bus.subscribe("*", () => received++);

  bus.redisSubscriber.emit("message", REDIS_EVENT_CHANNEL, JSON.stringify({ type: "invalid" }));
  bus.redisSubscriber.emit("message", REDIS_EVENT_CHANNEL, "not-json");

  assert.equal(received, 0);
  await bus.shutdown();
  FakeRedis.reset();
});

test("distributed mode refuses to start without Redis configuration", async () => {
  const bus = new EventBus({ RedisClass: FakeRedis });
  await assert.rejects(
    bus.initialize({ redisUrl: "", required: true }),
    /REDIS_URL is required/
  );
  assert.equal(bus.getDistributedStatus().enabled, false);
});

test("local event bus remains usable when distributed events are not configured", async () => {
  const bus = new EventBus({ RedisClass: FakeRedis });
  assert.equal(await bus.initialize({ redisUrl: "" }), false);
  let received = 0;
  bus.subscribe("agent.status", () => received++);
  bus.publish("agent.status", { state: "ready" }, { workspaceId: "local" });
  assert.equal(received, 1);
  await bus.shutdown();
});
