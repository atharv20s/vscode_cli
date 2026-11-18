/**
 * Adaptive Task Controller for ATH IDE 3.0
 * 
 * Dynamically selects and enforces workflow rigor based on task complexity:
 * - Low complexity: Fast direct execution
 * - Medium complexity: Discover -> Plan -> Implement -> Test -> Verify
 * - High complexity: Discover -> Diagnose -> Plan -> Implement -> Test -> Review -> Repair -> Verify
 */

export const TaskComplexity = {
  SMALL: "small",
  MEDIUM: "medium",
  LARGE: "large",
};

export const WorkflowPhases = {
  DISCOVER: "discover",
  DIAGNOSE: "diagnose",
  PLAN: "plan",
  IMPLEMENT: "implement",
  TEST: "test",
  REVIEW: "review",
  REPAIR: "repair",
  VERIFY: "verify",
  DONE: "done",
};

export class TaskController {
  constructor() {}

  /**
   * Classify task complexity based on intent, scale, and workspace signals.
   */
  classifyTask(prompt = "", { modifiedFileCount = 0, openTabsCount = 0 } = {}) {
    const p = String(prompt).toLowerCase();

    // Large task indicators
    const largePatterns = [
      /refactor/i, /architect/i, /migration/i, /migrate/i, /rewrite/i,
      /full-stack/i, /pipeline/i, /distributed/i, /system-wide/i, /database/i
    ];
    if (largePatterns.some(rx => rx.test(p)) || modifiedFileCount > 4) {
      return TaskComplexity.LARGE;
    }

    // Small task indicators
    const smallPatterns = [
      /typo/i, /rename/i, /spelling/i, /comment/i, /format/i, /lint fix/i,
      /what is/i, /explain/i, /where is/i, /show me/i
    ];
    if (smallPatterns.some(rx => rx.test(p)) && !p.includes("and") && p.length < 80) {
      return TaskComplexity.SMALL;
    }

    // Default to medium
    return TaskComplexity.MEDIUM;
  }

  /**
   * Return required workflow phases based on complexity.
   */
  getExecutionPhases(complexity) {
    switch (complexity) {
      case TaskComplexity.SMALL:
        return [WorkflowPhases.IMPLEMENT, WorkflowPhases.VERIFY, WorkflowPhases.DONE];

      case TaskComplexity.MEDIUM:
        return [
          WorkflowPhases.DISCOVER,
          WorkflowPhases.PLAN,
          WorkflowPhases.IMPLEMENT,
          WorkflowPhases.TEST,
          WorkflowPhases.VERIFY,
          WorkflowPhases.DONE,
        ];

      case TaskComplexity.LARGE:
      default:
        return [
          WorkflowPhases.DISCOVER,
          WorkflowPhases.DIAGNOSE,
          WorkflowPhases.PLAN,
          WorkflowPhases.IMPLEMENT,
          WorkflowPhases.TEST,
          WorkflowPhases.REVIEW,
          WorkflowPhases.REPAIR,
          WorkflowPhases.VERIFY,
          WorkflowPhases.DONE,
        ];
    }
  }

  /**
   * Transition to next phase based on outcome.
   */
  nextPhase(currentPhase, outcome = {}) {
    if (currentPhase === WorkflowPhases.TEST && outcome.testPassed === false) {
      return WorkflowPhases.REPAIR;
    }
    if (currentPhase === WorkflowPhases.REPAIR && outcome.repaired === true) {
      return WorkflowPhases.TEST; // re-test after repair
    }
    if (currentPhase === WorkflowPhases.REVIEW && outcome.approved === false) {
      return WorkflowPhases.IMPLEMENT; // rework rejected diff
    }

    const defaultSequence = [
      WorkflowPhases.DISCOVER,
      WorkflowPhases.DIAGNOSE,
      WorkflowPhases.PLAN,
      WorkflowPhases.IMPLEMENT,
      WorkflowPhases.TEST,
      WorkflowPhases.REVIEW,
      WorkflowPhases.VERIFY,
      WorkflowPhases.DONE,
    ];

    const idx = defaultSequence.indexOf(currentPhase);
    if (idx >= 0 && idx < defaultSequence.length - 1) {
      return defaultSequence[idx + 1];
    }
    return WorkflowPhases.DONE;
  }
}

export const taskController = new TaskController();
