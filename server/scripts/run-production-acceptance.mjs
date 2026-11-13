#!/usr/bin/env node
/**
 * Sequential production acceptance runner.
 *
 * Executes each live drill in order and continues after individual failures.
 * Some steps are interactive or destructive to their own disposable target:
 * terminal restart requires an operator restart, and Neon restore populates
 * only the explicitly configured empty target branch.
 */
import { spawn } from "node:child_process";
import path from "node:path";

const steps = [
  ["S3 signed upload/read-back", "../scripts/verify-s3-live.mjs"],
  ["S3 delete-and-worker-restore drill", "../scripts/verify-s3-restore-live.mjs"],
  ["Remote terminal recovery after worker restart", "../scripts/verify-terminal-restart.mjs"],
  ["Concurrent multi-user API isolation", "../scripts/verify-multi-user-isolation-live.mjs"],
  ["Encrypted Neon backup and restore to empty branch", "scripts/verify-neon-backup-restore.mjs"],
  ["Neon identity and 7-vs-2 migration count audit", "scripts/audit-neon-migration-counts.mjs"],
];

const results = [];
for (const [label, relativePath] of steps) {
  const script = path.resolve(process.cwd(), relativePath);
  console.log("\n" + "=".repeat(76));
  console.log("START:", label);
  console.log("Script:", script);
  console.log("=".repeat(76));
  const outcome = await new Promise(resolve => {
    const child = spawn(process.execPath, [script], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", error => resolve({ success: false, reason: error.message }));
    child.once("close", (code, signal) => resolve({
      success: code === 0,
      exitCode: code,
      signal: signal || null,
    }));
  });
  results.push({ step: label, ...outcome });
  console.log((outcome.success ? "PASS: " : "NOT PASSED: ") + label);
  // Deliberately continue: a missing secret, unavailable service or failed
  // drill must not prevent independent checks from running.
}

const passed = results.filter(result => result.success).length;
console.log("\n" + "=".repeat(76));
console.log("PRODUCTION ACCEPTANCE SUMMARY");
console.log(JSON.stringify({ passed, total: results.length, results }, null, 2));
console.log("=".repeat(76));
if (passed !== results.length) process.exitCode = 1;
