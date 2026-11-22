import test from "node:test";
import assert from "node:assert/strict";
import { SharedTaskState } from "./sharedTaskState.js";

test("SharedTaskState enforces typed artifacts and multi-agent completion gate", () => {
  const state = new SharedTaskState({ sessionId: "sess-123" });

  // 1. Planner sets task graph
  state.setTaskGraph("planner-agent", {
    tasks: [{ id: "t1", title: "Refactor auth", status: "completed" }],
  });
  assert.equal(state.artifacts.planner.tasks.length, 1);

  // 2. Context agent sets symbol map
  state.setSymbolMap("context-agent", {
    relevantFiles: ["src/auth.js"],
    symbols: ["verifyToken"],
  });
  assert.equal(state.artifacts.context.relevantFiles[0], "src/auth.js");

  // 3. Coder adds patch
  state.addPatch("coder-agent", {
    file: "src/auth.js",
    diff: "@@ -1 +1 @@",
    rationale: "Fix null check",
  });
  assert.equal(state.artifacts.coder.length, 1);

  // Ready should be false before testing and reviewing
  assert.equal(state.isReadyForCompletion(), false);

  // 4. Tester reports pass
  state.setTestEvidence("tester-agent", { passed: true, total: 10 });
  assert.equal(state.isReadyForCompletion(), false); // still requires reviewer approval

  // 5. Reviewer approves
  state.setReviewFindings("reviewer-agent", { approved: true, findings: [] });
  assert.equal(state.isReadyForCompletion(), true);
});
