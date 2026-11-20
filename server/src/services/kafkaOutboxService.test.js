import test from "node:test";
import assert from "node:assert/strict";
import { DURABLE_EVENT_TYPES, enqueueEventInTransaction } from "./kafkaOutboxService.js";

test("Kafka outbox allowlist contains lifecycle events but excludes terminal streams", () => {
  assert.equal(DURABLE_EVENT_TYPES.has("agent.command.completed"), true);
  assert.equal(DURABLE_EVENT_TYPES.has("file.changed"), true);
  assert.equal(DURABLE_EVENT_TYPES.has("terminal.output"), false);
  assert.equal(DURABLE_EVENT_TYPES.has("terminal.keystroke"), false);
});

test("enqueueEventInTransaction writes an event using the supplied transaction client", async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => { calls.push({ sql, params }); return { rowCount: 1 }; },
  };
  const event = {
    eventId: "evt_test_001",
    type: "agent.command.completed",
    timestamp: Date.now(),
    workspaceId: "workspace-test",
    sessionId: "session-test",
    payload: { commandId: "cmd-1", status: "completed" },
  };

  await enqueueEventInTransaction(client, event);

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO kafka_outbox/);
  assert.equal(calls[0].params[0], event.eventId);
  assert.equal(calls[0].params[2], event.workspaceId);
  assert.deepEqual(JSON.parse(calls[0].params[3]), event);
});

test("enqueueEventInTransaction rejects malformed envelopes", async () => {
  await assert.rejects(
    enqueueEventInTransaction({ query: async () => ({}) }, { eventId: "missing-fields" }),
    /Invalid event envelope/
  );
});
