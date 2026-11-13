import test from "node:test";
import assert from "node:assert/strict";
import { isPreviewVerificationUrl } from "./browserVerificationTools.js";

test("browser verification only accepts local or preview hostnames", () => {
  assert.equal(isPreviewVerificationUrl("http://localhost:5173").ok, true);
  assert.equal(isPreviewVerificationUrl("http://127.0.0.1:3000").ok, true);
  assert.equal(isPreviewVerificationUrl("https://abc.preview.example.com").ok, true);
  assert.equal(isPreviewVerificationUrl("https://169.254.169.254/latest/meta-data").ok, false);
  assert.equal(isPreviewVerificationUrl("https://example.com").ok, false);
  assert.equal(isPreviewVerificationUrl("file:///etc/passwd").ok, false);
});
