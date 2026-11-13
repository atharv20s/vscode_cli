import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_MODES,
  normalizeAgentMode,
  getAgentModes,
  selectAgentTools,
} from "./agentModes.js";

const definitions = [
  "read_file", "list_files", "git_status", "create_plan", "update_plan",
  "write_file", "edit_file", "delete_file", "run_command", "start_preview",
  "verify_workspace", "browser_verify", "github_create_pr",
].map(name => ({
  type: "function",
  function: { name, parameters: { type: "object", properties: {} } },
}));

test("agent mode registry exposes six supported modes and safe fallback", () => {
  assert.deepEqual(Object.keys(AGENT_MODES), ["ask", "plan", "edit", "agent", "debug", "review"]);
  assert.equal(normalizeAgentMode("unknown"), "agent");
  assert.equal(getAgentModes().length, 6);
});

test("ask and review modes expose read-only tools only", () => {
  for (const mode of ["ask", "review"]) {
    const names = selectAgentTools(definitions, mode).map(item => item.function.name);
    assert.ok(names.includes("read_file"));
    assert.ok(names.includes("git_status"));
    assert.ok(!names.includes("write_file"));
    assert.ok(!names.includes("run_command"));
    assert.ok(!names.includes("github_create_pr"));
  }
});

test("plan mode can create and update plans but cannot modify workspace", () => {
  const names = selectAgentTools(definitions, "plan").map(item => item.function.name);
  assert.ok(names.includes("create_plan"));
  assert.ok(names.includes("update_plan"));
  assert.ok(names.includes("read_file"));
  assert.ok(!names.includes("write_file"));
  assert.ok(!names.includes("run_command"));
});

test("edit and debug modes expose only their mode-specific tool groups", () => {
  const edit = selectAgentTools(definitions, "edit").map(item => item.function.name);
  assert.ok(edit.includes("write_file"));
  assert.ok(edit.includes("verify_workspace"));
  assert.ok(!edit.includes("run_command"));
  const debug = selectAgentTools(definitions, "debug").map(item => item.function.name);
  assert.ok(debug.includes("run_command"));
  assert.ok(debug.includes("browser_verify"));
});

test("agent mode is broad but specialist allowlists are intersected", () => {
  const names = selectAgentTools(definitions, "agent", ["read_file", "write_file"]).map(item => item.function.name);
  assert.deepEqual(names, ["read_file", "write_file"]);
});
