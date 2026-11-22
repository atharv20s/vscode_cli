import test from "node:test";
import assert from "node:assert/strict";
import { ProgressEvaluator, Recommendation } from "./progressEvaluator.js";

test("ProgressEvaluator detects repetitive action loops", () => {
  const evaluator = new ProgressEvaluator({ maxIdenticalActions: 2 });

  const result = evaluator.evaluateTurn({
    turnNumber: 3,
    recentActions: [
      { name: "read_file", argsHash: "hash_a" },
      { name: "read_file", argsHash: "hash_a" },
    ],
  });

  assert.equal(result.recommendation, Recommendation.HALT_LOOP);
  assert.equal(result.hasProgressed, false);
  assert.equal(result.alerts[0].includes("Loop detected"), true);
});

test("ProgressEvaluator detects stagnant errors without mutation", () => {
  const evaluator = new ProgressEvaluator({ maxSameErrors: 2 });

  const result = evaluator.evaluateTurn({
    turnNumber: 4,
    recentErrors: [
      "Cannot find module './database.js'",
      "Cannot find module './database.js'",
    ],
    mutationsCount: 0,
  });

  assert.equal(result.recommendation, Recommendation.CHANGE_TACTIC);
  assert.equal(result.hasProgressed, false);
  assert.equal(result.alerts[0].includes("Stagnant error"), true);
});
