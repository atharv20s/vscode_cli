import test from "node:test";
import assert from "node:assert/strict";
import { assertSafeId, shellQuote } from "./worktreeManager.js";

test("accepts bounded task identifiers and rejects shell metacharacters", () => {
  assert.equal(assertSafeId("frontend_task-2", "Task id"), "frontend_task-2");
  assert.throws(() => assertSafeId("../etc/passwd", "Task id"), /only letters/);
  assert.throws(() => assertSafeId("task; rm -rf /", "Task id"), /only letters/);
});

test("quotes shell arguments without allowing command substitution", () => {
  assert.equal(shellQuote("safe-name"), "'safe-name'");
  assert.equal(shellQuote("x'; touch /tmp/pwned; echo '"), "'x'\\''; touch /tmp/pwned; echo '\\''");
});
