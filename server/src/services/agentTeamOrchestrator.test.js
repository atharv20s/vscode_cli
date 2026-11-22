import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentTeamOrchestrator } from "./agentTeamOrchestrator.js";

test("orchestrates clean end-to-end pipeline: plan -> code -> test -> review", async () => {
  const steps = [];
  const runner = async (role, prompt, context) => {
    steps.push(role);
    if (role === "planner") return { success: true, output: "Step 1: write feature, Step 2: test" };
    if (role === "coder") return { success: true, output: "diff --git a/index.ts" };
    if (role === "tester") return { success: true, output: "All 5 tests passed." };
    if (role === "security_reviewer") return { success: true, output: "No vulnerabilities detected." };
    return { success: false, output: "unknown role" };
  };

  const orchestrator = new AgentTeamOrchestrator();
  const result = await orchestrator.runPipeline({
    goal: "Add validation endpoint",
    workspaceDir: "/workspace",
    agentRunner: runner,
  });

  assert.equal(result.success, true);
  assert.equal(result.stage, "complete");
  assert.deepEqual(steps, ["planner", "coder", "tester", "security_reviewer"]);
  assert.equal(result.repairs, 0);
});

test("triggers automatic test-driven repair loop when tester fails", async () => {
  let coderInvocations = 0;
  let testInvocations = 0;

  const runner = async (role) => {
    if (role === "planner") return { success: true, output: "plan" };
    if (role === "coder") {
      coderInvocations++;
      return { success: true, output: `code attempt ${coderInvocations}` };
    }
    if (role === "tester") {
      testInvocations++;
      // Fail on first attempt, pass on second
      if (testInvocations === 1) return { success: false, output: "SyntaxError: unexpected token" };
      return { success: true, output: "Tests passed after fix" };
    }
    if (role === "security_reviewer") return { success: true, output: "Approved" };
    return { success: false };
  };

  const orchestrator = new AgentTeamOrchestrator({ maxRepairAttempts: 2 });
  const result = await orchestrator.runPipeline({
    goal: "Fix bug",
    workspaceDir: "/workspace",
    agentRunner: runner,
  });

  assert.equal(result.success, true);
  assert.equal(result.repairs, 1);
  assert.equal(coderInvocations, 2);
  assert.equal(testInvocations, 2);
});

test("halts pipeline if security review rejects the diff", async () => {
  const runner = async (role) => {
    if (role === "planner") return { success: true, output: "plan" };
    if (role === "coder") return { success: true, output: "code" };
    if (role === "tester") return { success: true, output: "tests pass" };
    if (role === "security_reviewer") {
      return { success: false, output: "Critical blocker: SQL injection detected in query string." };
    }
    return { success: false };
  };

  const orchestrator = new AgentTeamOrchestrator();
  const result = await orchestrator.runPipeline({
    goal: "Add raw query",
    workspaceDir: "/workspace",
    agentRunner: runner,
  });

  assert.equal(result.success, false);
  assert.equal(result.stage, "review");
  assert.ok(result.error.includes("SQL injection detected"));
});
