import test from "node:test";
import assert from "node:assert/strict";
import { detectVerificationCommands } from "./verificationTools.js";
import { getSpecialistCapabilities } from "./specialistTools.js";

test("verification discovers only scripts declared by the project", () => {
  const checks = detectVerificationCommands({
    scripts: { typecheck: "tsc --noEmit", test: "vitest run", build: "vite build" },
  }, ["pnpm-lock.yaml"]);
  assert.deepEqual(checks.map(item => item.name), ["typecheck","test","build"]);
  assert.ok(checks.every(item => item.command.startsWith("pnpm ")));
});

test("verification returns no false pass when project has no checks", () => {
  assert.deepEqual(detectVerificationCommands({ scripts: {} }), []);
});

test("specialist capabilities are role-scoped", () => {
  assert.ok(getSpecialistCapabilities("reviewer").includes("git_diff"));
  assert.ok(!getSpecialistCapabilities("reviewer").includes("write_file"));
  assert.ok(getSpecialistCapabilities("coder").includes("write_file"));
  assert.ok(!getSpecialistCapabilities("coder").includes("delegate_specialist"));
});
