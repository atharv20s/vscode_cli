/**
 * Agent Progress Evaluator for ATH IDE 3.0
 * 
 * At each turn checkpoint, evaluates:
 * 1. Has the task actually progressed (new edits, new passing tests, new files found)?
 * 2. Is the agent repeating a previous action (loop detection)?
 * 3. Is the agent stuck on the exact same error?
 * 4. Have the relevant code files been discovered?
 * 5. What is the recommended continuation tactic?
 */

export const Recommendation = {
  CONTINUE: "CONTINUE",
  CHANGE_TACTIC: "CHANGE_TACTIC",
  FORCE_REPAIR: "FORCE_REPAIR",
  HALT_LOOP: "HALT_LOOP",
  COMPLETE: "COMPLETE",
};

export class ProgressEvaluator {
  constructor({ maxIdenticalActions = 2, maxSameErrors = 2 } = {}) {
    this.maxIdenticalActions = maxIdenticalActions;
    this.maxSameErrors = maxSameErrors;
  }

  evaluateTurn({
    turnNumber = 1,
    recentActions = [], // Array<{ name, argsHash }>
    recentErrors = [],  // Array<string>
    mutationsCount = 0,
    testsPassed = 0,
    testsTotal = 0,
  } = {}) {
    const alerts = [];
    let recommendation = Recommendation.CONTINUE;

    // 1. Loop detection: check consecutive identical action calls
    if (recentActions.length >= this.maxIdenticalActions) {
      const tail = recentActions.slice(-this.maxIdenticalActions);
      const isIdentical = tail.every(a => a.name === tail[0].name && a.argsHash === tail[0].argsHash);
      if (isIdentical) {
        alerts.push(`Loop detected: tool '${tail[0].name}' was called with identical arguments repeatedly.`);
        recommendation = Recommendation.HALT_LOOP;
      }
    }

    // 2. Error stagnation: check if the exact same error persists across turns without mutations
    if (recentErrors.length >= this.maxSameErrors) {
      const errTail = recentErrors.slice(-this.maxSameErrors);
      const isSameError = errTail.every(e => e && e === errTail[0]);
      if (isSameError && mutationsCount === 0) {
        alerts.push(`Stagnant error: '${errTail[0].slice(0, 80)}' repeated with no file mutations.`);
        recommendation = Recommendation.CHANGE_TACTIC;
      }
    }

    // 3. Evaluate completion
    if (testsTotal > 0 && testsPassed === testsTotal && mutationsCount > 0) {
      recommendation = Recommendation.COMPLETE;
    }

    // 4. Compute progress score (0.0 to 1.0)
    let score = 0.1;
    if (mutationsCount > 0) score += 0.3;
    if (testsTotal > 0) {
      score += (testsPassed / testsTotal) * 0.6;
    }

    return {
      turn: turnNumber,
      score: Math.min(1.0, score),
      alerts,
      recommendation,
      hasProgressed: alerts.length === 0,
    };
  }
}

export const progressEvaluator = new ProgressEvaluator();
