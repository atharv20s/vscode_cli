import test from "node:test";
import assert from "node:assert/strict";
import { ToolScheduler } from "./toolScheduler.js";

test("ToolScheduler partitions concurrent reads and serializes writes", () => {
  const scheduler = new ToolScheduler({ maxConcurrency: 4 });

  const calls = [
    { id: "1", name: "read_file", args: { path: "a.js" } },
    { id: "2", name: "read_file", args: { path: "b.js" } },
    { id: "3", name: "write_file", args: { path: "c.js", content: "..." } },
    { id: "4", name: "read_file", args: { path: "d.js" } },
  ];

  const batches = scheduler.partitionCalls(calls);
  assert.equal(batches.length, 3);
  assert.equal(batches[0].type, "concurrent_reads");
  assert.equal(batches[0].calls.length, 2);
  assert.equal(batches[1].type, "sequential");
  assert.equal(batches[1].calls[0].name, "write_file");
  assert.equal(batches[2].type, "concurrent_reads");
  assert.equal(batches[2].calls.length, 1);
});

test("ToolScheduler runs reads concurrently and records metrics", async () => {
  const scheduler = new ToolScheduler();
  const executionOrder = [];

  const calls = [
    { id: "r1", name: "read_file", args: { path: "f1.txt" } },
    { id: "r2", name: "read_file", args: { path: "f2.txt" } },
    { id: "w1", name: "write_file", args: { path: "out.txt", content: "data" } },
  ];

  const executor = async (name, args) => {
    executionOrder.push(`${name}:${args.path}`);
    return { success: true, output: `Contents of ${args.path}` };
  };

  const results = await scheduler.scheduleAndExecute(calls, executor);
  assert.equal(results.length, 3);
  assert.equal(results[0].success, true);
  assert.equal(results[2].success, true);
  assert.equal(executionOrder.includes("read_file:f1.txt"), true);
  assert.equal(executionOrder.includes("write_file:out.txt"), true);

  const metric = scheduler.metrics.get("read_file");
  assert.equal(metric.calls, 2);
});
