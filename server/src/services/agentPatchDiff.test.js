import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const sandbox = {};
vm.runInNewContext(readFileSync(new URL("../../public/js/agentPatchDiff.js", import.meta.url), "utf8"), {
  window: sandbox,
  globalThis: sandbox,
});
const { diffLines, applyHunks } = sandbox.AgentPatchDiff;

test("finds separate changed hunks and applies only accepted chunks", () => {
  const original = "one\ntwo\nthree\nfour\nfive";
  const proposed = "ONE\ntwo\nthree\nFOUR\nfive";
  const hunks = diffLines(original, proposed);
  assert.equal(hunks.length, 2);
  assert.equal(applyHunks(original, hunks, [hunks[1].id]), "one\ntwo\nthree\nFOUR\nfive");
  assert.equal(applyHunks(original, hunks, hunks.map(hunk => hunk.id)), proposed);
});

test("handles insertions, deletions and replacements", () => {
  const original = "a\nb\nc\nd";
  const proposed = "a\nx\nc\ny\nd";
  const hunks = diffLines(original, proposed);
  assert.equal(hunks.length, 2);
  assert.equal(applyHunks(original, hunks, hunks.map(hunk => hunk.id)), proposed);
  assert.equal(applyHunks(original, hunks, []), original);
});

test("preserves trailing newlines and returns no hunks for identical text", () => {
  assert.equal(diffLines("same\n", "same\n").length, 0);
  const hunks = diffLines("same\n", "changed\n");
  assert.equal(applyHunks("same\n", hunks, hunks.map(hunk => hunk.id)), "changed\n");
});

test("keeps large-file fallback bounded and correct for a localized edit", () => {
  const original = Array.from({ length: 1300 }, (_, index) => "line-" + index).join("\n");
  const proposed = original.replace("line-650", "changed-650");
  const hunks = diffLines(original, proposed);
  assert.equal(hunks.length, 1);
  assert.equal(applyHunks(original, hunks, [hunks[0].id]), proposed);
});

test("applies manually edited replacement text for an accepted hunk", () => {
  const original = "alpha\nbeta\ngamma";
  const proposed = "alpha\nBETA\ngamma";
  const hunks = diffLines(original, proposed);
  const edited = hunks.map(hunk => ({ ...hunk, replacement: ["beta // manually refined"] }));
  assert.equal(applyHunks(original, edited, [hunks[0].id]), "alpha\nbeta // manually refined\ngamma");
});
