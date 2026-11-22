import test from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "./agentRuntime.js";

test("AgentRuntime orchestrates planning, tool scheduling, and progress evaluation", async () => {
  const runtime = new AgentRuntime({ sessionId: "test-session" });

  // 1. Plan context
  const plan = await runtime.planContext("Refactor database query service and add tests");
  assert.equal(typeof plan.repoMapBlock, "string");
  assert.equal(plan.complexity, "large");

  // 2. Execute tools through scheduler
  const toolCalls = [
    { id: "c1", name: "read_file", arguments: JSON.stringify({ path: "src/db.js" }) },
    { id: "c2", name: "write_file", arguments: JSON.stringify({ path: "src/db.js", content: "..." }) },
  ];

  const executor = async (name, args) => {
    return { success: true, output: `Executed ${name}` };
  };

  const results = await runtime.executeTools(toolCalls, executor);
  assert.equal(results.length, 2);
  assert.equal(runtime.mutationsCount, 1);
  assert.equal(runtime.memory.fileLedger.has("src/db.js"), true);

  // 3. Progress evaluation
  const progress = runtime.evaluateTurnProgress();
  assert.equal(progress.turn, 1);
  assert.equal(progress.hasProgressed, true);
});
