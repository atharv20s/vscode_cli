import test from "node:test";
import assert from "node:assert/strict";
import { EvidenceVerifier } from "./evidenceVerifier.js";

test("EvidenceVerifier parses Node.js test failures into structured evidence", () => {
  const verifier = new EvidenceVerifier();

  const rawTestOutput = `
✔ database tests passed (10ms)
✖ user authentication validates JWT token signature (45ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  + false
  - true
      at TestContext.<anonymous> (c:/app/src/auth/jwt.test.js:32:14)
`;

  const evidence = verifier.parseTestOutput(rawTestOutput, {
    changedFiles: ["src/auth/jwt.js"],
  });

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].testName, "user authentication validates JWT token signature");
  assert.equal(evidence[0].file, "c:/app/src/auth/jwt.test.js");
  assert.equal(evidence[0].line, 32);
  assert.equal(evidence[0].severity, "HIGH");
  assert.equal(evidence[0].suggestedRepair.includes("Update the logic"), true);

  const prompt = verifier.generateRepairPrompt(evidence);
  assert.equal(prompt.includes("Evidence-Based Verification Failure"), true);
  assert.equal(prompt.includes("Failure #1: user authentication validates JWT token signature"), true);

  const completion = verifier.evaluateCompletion(evidence);
  assert.equal(completion.verified, false);
});
