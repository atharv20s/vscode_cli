import test from "node:test";
import assert from "node:assert/strict";
import { repoIntelligence } from "../repoIntelligence.js";
import { TaskMemory } from "../taskMemory.js";
import { taskController, TaskComplexity, WorkflowPhases } from "../taskController.js";
import { toolScheduler } from "../toolScheduler.js";
import { evidenceVerifier } from "../evidenceVerifier.js";
import { progressEvaluator, Recommendation } from "../progressEvaluator.js";
import { SharedTaskState } from "../sharedTaskState.js";
import { AgentRuntime } from "./agentRuntime.js";

test("ATH IDE 3.0 Acceptance 1: Task Classification routes to correct phases", () => {
  const smallPhases = taskController.getExecutionPhases(taskController.classifyTask("fix typo in button text"));
  assert.deepEqual(smallPhases, [WorkflowPhases.IMPLEMENT, WorkflowPhases.VERIFY, WorkflowPhases.DONE]);

  const largePhases = taskController.getExecutionPhases(
    taskController.classifyTask("refactor distributed authentication architecture and migrate database")
  );
  assert.equal(largePhases.includes(WorkflowPhases.DISCOVER), true);
  assert.equal(largePhases.includes(WorkflowPhases.DIAGNOSE), true);
  assert.equal(largePhases.includes(WorkflowPhases.PLAN), true);
  assert.equal(largePhases.includes(WorkflowPhases.REVIEW), true);
  assert.equal(largePhases.includes(WorkflowPhases.REPAIR), true);
});

test("ATH IDE 3.0 Acceptance 2: AST Repo Intelligence builds dependency graph and symbol map", () => {
  const sampleCode = `
import { DatabasePool } from "./db.js";
export class AuthService {
  async login(user, pass) { return true; }
}
export function validateSession(token) {}
`;
  const result = repoIntelligence.extractSymbolsAndImports(sampleCode, ".js");
  assert.equal(result.imports.includes("./db.js"), true);
  assert.equal(result.symbols.some(s => s.name === "AuthService" && s.kind === "class"), true);
  assert.equal(result.symbols.some(s => s.name === "validateSession" && s.kind === "function"), true);
  assert.equal(result.exports.includes("AuthService"), true);
  assert.equal(result.exports.includes("validateSession"), true);
});

test("ATH IDE 3.0 Acceptance 3: Durable Memory survives context compaction & produces State Document", () => {
  const mem = new TaskMemory({
    objective: "Implement resilient distributed worker leases",
    criteria: ["Zero split-brain", "Crash recovery within 15s"],
  });

  mem.recordDecision("Adopt Redis Lua scripts", "Ensures atomic capacity check and reservation");
  mem.recordFileMutation("src/workerRegistry.js", { action: "write", summary: "Added Lua reservation script" });
  mem.recordTestResult("workerRegistry.test.js", { passed: true, durationMs: 40 });
  mem.setNextAction("Verify TTL lease expiration under worker crash");

  const doc = mem.compressToStateDocument();
  assert.equal(doc.includes("Adopt Redis Lua scripts"), true);
  assert.equal(doc.includes("src/workerRegistry.js"), true);
  assert.equal(doc.includes("workerRegistry.test.js"), true);
  assert.equal(doc.includes("Zero split-brain"), true);
});

test("ATH IDE 3.0 Acceptance 4: Parallel Tool Scheduler batches concurrent reads and serializes writes", async () => {
  const calls = [
    { id: "r1", name: "read_file", args: { path: "a.js" } },
    { id: "r2", name: "read_file", args: { path: "b.js" } },
    { id: "r3", name: "search_files", args: { query: "token" } },
    { id: "w1", name: "write_file", args: { path: "a.js", content: "new" } },
    { id: "r4", name: "read_file", args: { path: "c.js" } },
  ];

  const partitions = toolScheduler.partitionCalls(calls);
  assert.equal(partitions.length, 3);
  assert.equal(partitions[0].type, "concurrent_reads");
  assert.equal(partitions[0].calls.length, 3);
  assert.equal(partitions[1].type, "sequential");
  assert.equal(partitions[1].calls[0].name, "write_file");
  assert.equal(partitions[2].type, "concurrent_reads");
  assert.equal(partitions[2].calls.length, 1);
});

test("ATH IDE 3.0 Acceptance 5: Evidence Verifier extracts file/line and generates targeted repair directive", () => {
  const mockTestError = `
✔ server setup (5ms)
✖ worker lease rejects expired tokens (22ms)
  AssertionError [ERR_ASSERTION]: Expected status 401 but received 200
      at TestContext.<anonymous> (c:/server/src/worker.test.js:45:10)
`;

  const evidence = evidenceVerifier.parseTestOutput(mockTestError, {
    changedFiles: ["src/worker.js"],
  });

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].testName, "worker lease rejects expired tokens");
  assert.equal(evidence[0].file, "c:/server/src/worker.test.js");
  assert.equal(evidence[0].line, 45);

  const repairPrompt = evidenceVerifier.generateRepairPrompt(evidence);
  assert.equal(repairPrompt.includes("Evidence-Based Verification Failure"), true);
  assert.equal(repairPrompt.includes("worker lease rejects expired tokens"), true);
  assert.equal(repairPrompt.includes("c:/server/src/worker.test.js:45"), true);
});

test("ATH IDE 3.0 Acceptance 6: Progress Evaluator flags execution loops and stagnant errors", () => {
  // Loop detection
  const loopCheck = progressEvaluator.evaluateTurn({
    turnNumber: 3,
    recentActions: [
      { name: "read_file", argsHash: "hash-same" },
      { name: "read_file", argsHash: "hash-same" },
    ],
  });
  assert.equal(loopCheck.recommendation, Recommendation.HALT_LOOP);
  assert.equal(loopCheck.hasProgressed, false);

  // Error stagnation check
  const stagnantCheck = progressEvaluator.evaluateTurn({
    turnNumber: 4,
    recentErrors: ["Database connection refused", "Database connection refused"],
    mutationsCount: 0,
  });
  assert.equal(stagnantCheck.recommendation, Recommendation.CHANGE_TACTIC);
});

test("ATH IDE 3.0 Acceptance 7: Multi-Agent Shared State enforces typed artifacts and approval gates", () => {
  const shared = new SharedTaskState({ sessionId: "collab-session" });

  shared.setTaskGraph("planner", {
    tasks: [{ id: "1", title: "Implement AST", status: "completed" }],
  });
  shared.addPatch("coder", {
    file: "src/ast.js",
    diff: "@@ -1 +1 @@",
    rationale: "Added tree-sitter bindings",
  });

  // Not ready before test and review
  assert.equal(shared.isReadyForCompletion(), false);

  shared.setTestEvidence("tester", { passed: true, total: 5 });
  assert.equal(shared.isReadyForCompletion(), false); // requires reviewer approval

  shared.setReviewFindings("reviewer", { approved: true, findings: [] });
  assert.equal(shared.isReadyForCompletion(), true);
});

test("ATH IDE 3.0 Acceptance 8: Full AgentRuntime integration cycle", async () => {
  const runtime = new AgentRuntime({ sessionId: "integration-session" });

  const contextPlan = await runtime.planContext("Refactor API router and add integration tests");
  assert.equal(contextPlan.complexity, "large");

  const results = await runtime.executeTools(
    [
      { id: "call_1", name: "read_file", arguments: JSON.stringify({ path: "routes.js" }) },
      { id: "call_2", name: "write_file", arguments: JSON.stringify({ path: "routes.js", content: "export const r = 1;" }) },
    ],
    async (name, args) => ({ success: true, output: `Handled ${name}` })
  );

  assert.equal(results.length, 2);
  assert.equal(runtime.mutationsCount, 1);
  assert.equal(runtime.memory.fileLedger.has("routes.js"), true);

  const turnCheck = runtime.evaluateTurnProgress();
  assert.equal(turnCheck.hasProgressed, true);
  assert.equal(turnCheck.turn, 1);
});
