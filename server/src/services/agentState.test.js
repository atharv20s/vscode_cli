import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

test("agent state machine enforces explicit transitions", () => {
  const sandbox = { CustomEvent: class extends Event { constructor(type, options) { super(type); this.detail = options.detail; } } };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(new URL("../../public/js/agentState.js", import.meta.url), "utf8"), sandbox);
  const machine = new sandbox.AgentStateMachine();
  machine.transition("planning", { runId: "run-1" });
  machine.transition("editing");
  machine.transition("awaiting_approval");
  assert.equal(machine.state, "awaiting_approval");
  assert.throws(() => machine.transition("planning"), /Invalid agent state transition/);
});
