import assert from "node:assert/strict";
import test from "node:test";
import { BoundedOutputCapture } from "./boundedOutputCapture.js";

test("captures stdout and stderr independently while preserving combined arrival order", () => {
  const capture = new BoundedOutputCapture({ maxBytes: 256 });
  capture.append("stdout", "out-1");
  capture.append("stderr", "err-1");
  capture.append("stdout", "out-2");
  const result = capture.snapshot();
  assert.equal(result.output, "out-1err-1out-2");
  assert.equal(result.stdout, "out-1out-2");
  assert.equal(result.stderr, "err-1");
  assert.equal(result.totalBytes, 15);
  assert.equal(result.truncated, false);
});

test("bounds large output but retains its beginning, end and omitted-byte count", () => {
  const capture = new BoundedOutputCapture({ maxBytes: 128 });
  const first = "A".repeat(100);
  const second = "B".repeat(100);
  capture.append("stdout", first);
  capture.append("stderr", second);
  const result = capture.snapshot();
  assert.equal(result.totalBytes, 200);
  assert.equal(result.truncated, true);
  assert.equal(result.truncatedBytes, 72);
  assert.ok(result.output.startsWith("A".repeat(64)));
  assert.ok(result.output.includes("72 bytes omitted"));
  assert.ok(result.output.endsWith("B".repeat(64)));
  assert.equal(Buffer.byteLength(result.stdout) <= 64 + 80, true);
});

test("rejects invalid stream names and invalid limits", () => {
  assert.throws(() => new BoundedOutputCapture({ maxBytes: 32 }), /at least 128/);
  const capture = new BoundedOutputCapture();
  assert.throws(() => capture.append("combined", "bad"), /stdout or stderr/);
});
