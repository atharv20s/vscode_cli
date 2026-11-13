import test from "node:test";
import assert from "node:assert/strict";
import {
  registerAgentHook,
  unregisterAgentHook,
  triggerAgentHooks,
  clearAgentHooks,
  AgentHookError,
} from "./agentLifecycleHooks.js";

test("before hooks can veto an action fail-closed", async () => {
  clearAgentHooks();
  const remove = registerAgentHook("before_tool", async context => ({
    blocked: context.toolName === "run_command",
    reason: "Commands are disabled by policy.",
  }));
  await assert.rejects(
    triggerAgentHooks("before_tool", { toolName: "run_command" }, { failClosed: true }),
    error => error instanceof AgentHookError && /disabled by policy/.test(error.message),
  );
  const allowed = await triggerAgentHooks("before_tool", { toolName: "read_file" }, { failClosed: true });
  assert.equal(allowed.allowed, true);
  remove();
  clearAgentHooks();
});

test("after hooks collect errors without changing action result", async () => {
  clearAgentHooks();
  const handler = async () => { throw new Error("metrics unavailable"); };
  registerAgentHook("after_tool", handler);
  const result = await triggerAgentHooks("after_tool", { toolName: "read_file" });
  assert.equal(result.allowed, true);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].message, "metrics unavailable");
  clearAgentHooks();
});

test("unregister removes only the requested handler", async () => {
  clearAgentHooks();
  let calls = 0;
  const first = () => { calls += 1; };
  const second = () => { calls += 10; };
  registerAgentHook("after_request", first);
  registerAgentHook("after_request", second);
  assert.equal(unregisterAgentHook("after_request", first), true);
  await triggerAgentHooks("after_request");
  assert.equal(calls, 10);
  clearAgentHooks();
});
