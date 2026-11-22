import test from "node:test";
import assert from "node:assert/strict";
import { TaskController, TaskComplexity, WorkflowPhases } from "./taskController.js";

test("TaskController classifies small, medium, and large tasks appropriately", () => {
  const controller = new TaskController();

  assert.equal(controller.classifyTask("fix typo in README"), TaskComplexity.SMALL);
  assert.equal(controller.classifyTask("refactor database connection pool and migrate schema"), TaskComplexity.LARGE);
  assert.equal(controller.classifyTask("add input validation to register form"), TaskComplexity.MEDIUM);
});

test("TaskController routes through repair when tests fail and returns to test after repair", () => {
  const controller = new TaskController();

  // If test fails, route to repair
  const afterTestFail = controller.nextPhase(WorkflowPhases.TEST, { testPassed: false });
  assert.equal(afterTestFail, WorkflowPhases.REPAIR);

  // After repair succeeds, route back to test
  const afterRepair = controller.nextPhase(WorkflowPhases.REPAIR, { repaired: true });
  assert.equal(afterRepair, WorkflowPhases.TEST);
});
