import test from "node:test";
import assert from "node:assert/strict";
import { TaskMemory } from "./taskMemory.js";

test("TaskMemory records decisions, mutations, tests, and compresses to state doc", () => {
  const mem = new TaskMemory({
    objective: "Implement Redis-backed worker lease registry",
    criteria: ["Atomic reservations via Lua", "TTL expires dead workers"],
  });

  mem.recordDecision("Use Redis Hash with TTL", "Ensures atomic worker lookups and clean crash expiry");
  mem.recordFileMutation("src/services/workerRegistry.js", { action: "write", summary: "Added WorkerRegistry class" });
  mem.recordTestResult("workerRegistry.test.js", { passed: true, durationMs: 45 });
  mem.recordFailure("Uncaught Redis Timeout", { severity: "high", suggestedFix: "Add socket timeout option" });
  mem.setNextAction("Wire Redis client in execution service");

  const stateDoc = mem.compressToStateDocument();
  assert.equal(stateDoc.includes("Implement Redis-backed worker lease registry"), true);
  assert.equal(stateDoc.includes("Use Redis Hash with TTL"), true);
  assert.equal(stateDoc.includes("src/services/workerRegistry.js"), true);
  assert.equal(stateDoc.includes("workerRegistry.test.js"), true);
  assert.equal(stateDoc.includes("Uncaught Redis Timeout"), true);
  assert.equal(stateDoc.includes("Wire Redis client in execution service"), true);

  // Check prompt memory format
  const promptMem = mem.formatPromptMemory();
  assert.equal(promptMem.includes("workerRegistry.js"), true);

  // Test resolving failure
  mem.resolveFailure("Uncaught Redis Timeout");
  const updatedDoc = mem.compressToStateDocument();
  assert.equal(updatedDoc.includes("None — all known checks passing"), true);
});
