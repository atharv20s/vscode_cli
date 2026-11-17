import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

test("agent state machine enforces explicit transitions and notifies subscribers", () => {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(new URL("../../public/js/agentState.js", import.meta.url), "utf8"), sandbox);
  const machine = new sandbox.window.AgentStateMachine();
  const events = [];
  machine.subscribe(event => events.push(event));
  machine.transition("planning", { runId: "run-1" });
  machine.transition("editing");
  machine.transition("awaiting_approval");
  assert.equal(machine.state, "awaiting_approval");
  assert.equal(events.length, 3);
  assert.throws(() => machine.transition("planning"), /Invalid agent state transition/);
});
