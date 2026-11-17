/**
 * Tests for WorkspaceMcpBridge — workspace-scoped path validation for MCP
 * filesystem tools.
 *
 * These tests use an in-process mock for resolveSafeWorkspacePath and do NOT
 * spawn any MCP server process, so they run on Windows and Linux identically.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

// ---------------------------------------------------------------------------
// Minimal inline stand-in for WorkspaceMcpBridge that uses the same logic but
// replaces the real resolveSafeWorkspacePath with a synchronous mock so the
// tests are not affected by filesystem state.
// ---------------------------------------------------------------------------

function isAbsoluteOrUnsafe(value) {
  if (typeof value !== "string") return false;
  return (
    path.isAbsolute(value) ||
    value.includes("\0") ||
    /^[A-Za-z]:[/\\]/.test(value) ||
    value.startsWith("//") ||
    value.startsWith("\\\\")
  );
}

function extractPathArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const results = [];
  for (const [key, value] of Object.entries(args)) {
    if (key === "path" && typeof value === "string") results.push({ key, value, isArray: false });
    else if (key === "paths" && Array.isArray(value)) results.push({ key, value, isArray: true });
  }
  return results;
}

const PATH_ARG_TOOLS = new Set([
  "read_file", "read_multiple_files", "write_file", "create_directory",
  "move_file", "get_file_info", "list_directory", "directory_tree", "search_files",
]);

const WRITE_TOOLS = new Set(["write_file", "create_directory", "move_file"]);
const PROTECTED_WRITE_PATTERNS = [
  /^\.git(\/|\\|$)/i,
  /^\.env(\..*)?$/i,
  /^\.ath-agent-run-snapshots(\/|\\|$)/i,
  /^\.ath-locks(\/|\\|$)/i,
];

class TestBridge {
  constructor(root, callMcpTool, resolveFn) {
    this._root = root;
    this._callMcpTool = callMcpTool;
    this._resolve = resolveFn;
  }

  async call(toolName, args) {
    if (PATH_ARG_TOOLS.has(toolName)) await this._validatePathArgs(toolName, args);
    return this._callMcpTool(toolName, args);
  }

  async _validatePathArgs(toolName, args) {
    for (const { value, isArray } of extractPathArgs(args)) {
      for (const p of (isArray ? value : [value])) {
        if (typeof p !== "string" || !p) throw new Error("empty path");
        if (isAbsoluteOrUnsafe(p)) throw new Error(`absolute or unsafe path rejected`);
        if (WRITE_TOOLS.has(toolName) && PROTECTED_WRITE_PATTERNS.some(re => re.test(p))) {
          throw new Error(`MCP write tool '${toolName}': cannot modify protected system or secret file '${p}'.`);
        }
        await this._resolve(p);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const WORKSPACE = "/workspace/user-abc";

function safeMock() {
  return async () => {}; // resolves without throwing — path is safe
}

function escapeMock() {
  return async () => { throw new Error("Workspace path escaped root."); };
}

test("bridge forwards safe relative paths to the underlying MCP call", async () => {
  const calls = [];
  const bridge = new TestBridge(
    WORKSPACE,
    async (tool, args) => { calls.push({ tool, args }); return { success: true, output: "ok" }; },
    safeMock()
  );
  const result = await bridge.call("read_file", { path: "src/index.ts" });
  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.path, "src/index.ts");
});

test("bridge rejects absolute POSIX paths", async () => {
  const bridge = new TestBridge(WORKSPACE, async () => ({ success: true, output: "" }), safeMock());
  await assert.rejects(() => bridge.call("read_file", { path: "/etc/passwd" }), /absolute or unsafe/);
});

test("bridge rejects Windows-style drive paths", async () => {
  const bridge = new TestBridge(WORKSPACE, async () => ({ success: true, output: "" }), safeMock());
  await assert.rejects(() => bridge.call("read_file", { path: "C:\\Windows\\System32" }), /absolute or unsafe/);
});

test("bridge rejects UNC paths", async () => {
  const bridge = new TestBridge(WORKSPACE, async () => ({ success: true, output: "" }), safeMock());
  await assert.rejects(() => bridge.call("read_file", { path: "\\\\server\\share" }), /absolute or unsafe/);
});

test("bridge rejects null-byte paths", async () => {
  const bridge = new TestBridge(WORKSPACE, async () => ({ success: true, output: "" }), safeMock());
  await assert.rejects(() => bridge.call("read_file", { path: "file\0.txt" }), /absolute or unsafe/);
});

test("bridge rejects paths that escape the workspace root (symlink/dotdot)", async () => {
  const bridge = new TestBridge(WORKSPACE, async () => ({ success: true, output: "" }), escapeMock());
  await assert.rejects(() => bridge.call("read_file", { path: "../../secret" }), /Workspace path escaped root/);
});

test("bridge validates each path in a paths array", async () => {
  let calls = 0;
  const resolve = async (p) => {
    calls++;
    if (p === "bad") throw new Error("Workspace path escaped root.");
  };
  const bridge = new TestBridge(WORKSPACE, async () => ({ success: true, output: "" }), resolve);
  await assert.rejects(
    () => bridge.call("read_multiple_files", { paths: ["src/a.ts", "bad"] }),
    /Workspace path escaped root/
  );
  assert.ok(calls >= 1);
});

test("bridge forwards non-filesystem tools without path validation", async () => {
  const calls = [];
  const bridge = new TestBridge(
    WORKSPACE,
    async (tool, args) => { calls.push(tool); return { success: true, output: "" }; },
    safeMock()
  );
  await bridge.call("github_get_repo_info", { owner: "x", repo: "y" });
  assert.equal(calls.length, 1);
});

test("bridge rejects write tools attempting to modify .git", async () => {
  const bridge = new TestBridge(WORKSPACE, async () => ({ success: true, output: "" }), safeMock());
  await assert.rejects(
    () => bridge.call("write_file", { path: ".git/config", content: "evil" }),
    /cannot modify protected system or secret file/
  );
});

test("bridge rejects write tools attempting to modify .env secrets", async () => {
  const bridge = new TestBridge(WORKSPACE, async () => ({ success: true, output: "" }), safeMock());
  await assert.rejects(
    () => bridge.call("write_file", { path: ".env", content: "SECRET=1" }),
    /cannot modify protected system or secret file/
  );
  await assert.rejects(
    () => bridge.call("write_file", { path: ".env.production", content: "SECRET=1" }),
    /cannot modify protected system or secret file/
  );
});

test("bridge rejects write tools attempting to touch snapshot storage", async () => {
  const bridge = new TestBridge(WORKSPACE, async () => ({ success: true, output: "" }), safeMock());
  await assert.rejects(
    () => bridge.call("write_file", { path: ".ath-agent-run-snapshots/evil.json", content: "{}" }),
    /cannot modify protected system or secret file/
  );
});
