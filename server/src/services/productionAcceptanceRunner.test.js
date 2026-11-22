import { test } from "node:test";
import assert from "node:assert/strict";
import { runProductionAcceptanceChecks } from "./productionAcceptanceRunner.js";

test("runs production acceptance checks and generates complete report", async () => {
  const report = await runProductionAcceptanceChecks();

  assert.equal(report.suite, "ATH IDE 2.0 Production Acceptance");
  assert.ok(report.timestamp);
  assert.equal(report.overall, "PASSED");
  assert.equal(report.failures, 0);
  assert.ok(report.totalChecks >= 5);

  const categories = report.checks.map(c => c.category);
  assert.ok(categories.includes("database"));
  assert.ok(categories.includes("concurrency"));
  assert.ok(categories.includes("storage"));
  assert.ok(categories.includes("security"));
  assert.ok(categories.includes("runtime"));
});
