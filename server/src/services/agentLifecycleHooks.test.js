import test from "node:test";
import assert from "node:assert/strict";
import { clearAgentHooks, registerAgentHook, runAgentHooks } from "./agentLifecycleHooks.js";

test("hooks run in priority order and receive immutable metadata", async () => {
  clearAgentHooks();
  const calls = [];
  registerAgentHook("before_tool", async context => {
    calls.push("late");
    assert.equal(context.toolName, "read_file");
    assert.equal(Object.isFrozen(context), true);
  }, { id: "late", priority: 1 });
  registerAgentHook("before_tool", async () => { calls.push("early"); }, { id: "early", priority: 5 });
  const result = await runAgentHooks("before_tool", { toolName: "read_file" });
  assert.deepEqual(calls, ["early", "late"]);
  assert.equal(result.blocked, false);
  clearAgentHooks();
});

test("a gate hook can deny but never grant execution", async () => {
  clearAgentHooks();
  registerAgentHook("before_tool", async () => ({ block: true, reason: "Policy denied this tool." }));
  const result = await runAgentHooks("before_tool", { toolName: "run_command" });
  assert.deepEqual(result, { blocked: true, reason: "Policy denied this tool." });
  clearAgentHooks();
});

test("critical gate failures fail closed while observer failures do not", async () => {
  clearAgentHooks();
  registerAgentHook("before_request", async () => { throw new Error("policy backend unavailable"); }, { critical: true });
  assert.equal((await runAgentHooks("before_request")).blocked, true);
  clearAgentHooks();
  registerAgentHook("before_request", async () => { throw new Error("telemetry offline"); });
  assert.equal((await runAgentHooks("before_request")).blocked, false);
  clearAgentHooks();
});

test("hook registration validates stages and handlers", () => {
  assert.throws(() => registerAgentHook("unknown", () => {}), TypeError);
  assert.throws(() => registerAgentHook("before_tool", "not-a-function"), TypeError);
});
