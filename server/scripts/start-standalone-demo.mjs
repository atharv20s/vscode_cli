#!/usr/bin/env node
/**
 * Zero-Config Standalone Developer & Demo Launcher
 *
 * Boots ATH IDE locally with zero external dependencies (no Postgres, Redis, or Docker required).
 * Preloads a sample TypeScript project into the workspace for immediate testing of:
 * - Ctrl+K Inline Edits
 * - Ctrl+I Composer Agent
 * - Multi-Hunk View Zone Reviews
 * - 1-Click Rollback
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEMO_WS = path.join(ROOT, "data", "demo-workspace");

async function setupDemoWorkspace() {
  await fs.mkdir(path.join(DEMO_WS, "src"), { recursive: true });

  // Sample package.json
  const pkgJson = {
    name: "ath-demo-project",
    version: "1.0.0",
    type: "module",
    scripts: {
      test: "node --test src/**/*.test.js",
      typecheck: "tsc --noEmit",
      build: "tsc",
    },
    dependencies: {},
  };
  await fs.writeFile(path.join(DEMO_WS, "package.json"), JSON.stringify(pkgJson, null, 2), "utf8");

  // Sample source code with intentional function to improve/edit
  const calcCode = `/**
 * Simple arithmetic operations module.
 */
export function add(a, b) {
  return a + b;
}

export function subtract(a, b) {
  return a - b;
}

export function multiply(a, b) {
  return a * b;
}

export function divide(a, b) {
  if (b === 0) throw new Error("Division by zero");
  return a / b;
}
`;
  await fs.writeFile(path.join(DEMO_WS, "src", "calculator.js"), calcCode, "utf8");

  // Sample unit test
  const testCode = `import { test } from "node:test";
import assert from "node:assert/strict";
import { add, subtract, multiply, divide } from "./calculator.js";

test("add computes sum", () => {
  assert.equal(add(2, 3), 5);
});

test("divide handles zero division gracefully", () => {
  assert.throws(() => divide(10, 0), /Division by zero/);
});
`;
  await fs.writeFile(path.join(DEMO_WS, "src", "calculator.test.js"), testCode, "utf8");

  // Sample AGENTS.md instructions
  const agentsMd = `# Agent Instructions for Demo Project

- Write modern JavaScript/TypeScript with clear JSDoc annotations.
- Keep tests in src/**/*.test.js using node:test.
- When fixing or adding functions, run the test suite to verify.
`;
  await fs.writeFile(path.join(DEMO_WS, "AGENTS.md"), agentsMd, "utf8");

  // Also seed into any active user workspaces in DEMO_WS/users
  try {
    const usersDir = path.join(DEMO_WS, "users");
    const userDirs = await fs.readdir(usersDir);
    for (const u of userDirs) {
      const uPath = path.join(usersDir, u);
      const stat = await fs.stat(uPath);
      if (stat.isDirectory()) {
        await fs.mkdir(path.join(uPath, "src"), { recursive: true });
        await fs.writeFile(path.join(uPath, "package.json"), JSON.stringify(pkgJson, null, 2), "utf8");
        await fs.writeFile(path.join(uPath, "src", "calculator.js"), calcCode, "utf8");
        await fs.writeFile(path.join(uPath, "src", "calculator.test.js"), testCode, "utf8");
        await fs.writeFile(path.join(uPath, "AGENTS.md"), agentsMd, "utf8");
      }
    }
  } catch {}
}

async function main() {
  console.log("=================================================");
  console.log("   🚀 ATH IDE 2.0 — Standalone Demo Launcher   ");
  console.log("=================================================");

  console.log("Setting up demo workspace at:", DEMO_WS);
  await setupDemoWorkspace();

  // Set environment for local standalone mode
  process.env.NODE_ENV = "development";
  process.env.PORT = process.env.PORT || "3001";
  process.env.WORKSPACE_ROOT = DEMO_WS;
  process.env.EXECUTION_RUNTIME = "disabled";
  process.env.REDIS_URL = "";
  process.env.REQUIRE_POSTGRES = "false";
  process.env.REQUIRE_DISTRIBUTED_EVENTS = "false";

  console.log("Starting ATH IDE 2.0 server on http://localhost:" + process.env.PORT);
  console.log("");
  console.log("Hotkeys inside Monaco Editor:");
  console.log("  • Ctrl+K / Cmd+K : Open Inline Edit floating prompt");
  console.log("  • Ctrl+I / Cmd+I : Focus Composer autonomous agent");
  console.log("  • Ctrl+Y / Cmd+Y : Accept proposed hunk");
  console.log("  • Ctrl+N / Cmd+N : Reject proposed hunk");
  console.log("=================================================");

  // Boot server
  await import("../src/server.js");
}

main().catch(err => {
  console.error("Launcher failed:", err);
  process.exit(1);
});
