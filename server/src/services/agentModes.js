/**
 * ATH IDE agent modes.
 *
 * Modes constrain available capabilities in addition to shaping the prompt.
 * Tool permissions in the runtime remain authoritative; a prompt never grants
 * an operation that the permission engine denies.
 */
export const AGENT_MODES = Object.freeze({
  ask: {
    label: "Ask",
    description: "Inspect and explain without changing the workspace.",
    prompt: `## ASK MODE
Answer questions using evidence from the active workspace and tools.
Do not create, modify, delete, compile, preview, or execute workspace code.
When a question requires a change, explain what would need to change and ask
the user to switch to Edit or Agent mode.`,
  },
  plan: {
    label: "Plan",
    description: "Inspect the project and produce an actionable implementation plan.",
    prompt: `## PLAN MODE
Inspect the current project before planning. Produce ordered steps, affected
files, dependencies, risks, acceptance criteria, and verification commands.
Do not implement code or run state-changing commands. A plan is not evidence
that implementation or tests have completed.`,
  },
  edit: {
    label: "Edit",
    description: "Make focused changes and verify them.",
    prompt: `## EDIT MODE
Make the smallest focused change that satisfies the request. Inspect each
target before editing, preserve unrelated work, and verify syntax/tests after
changes. Do not perform broad refactors or publish/deploy changes.`,
  },
  agent: {
    label: "Agent",
    description: "Autonomous multi-step engineering with verification.",
    prompt: `## AGENT MODE
Work end to end: inspect, plan, implement, run relevant checks, repair failures,
and report changed files and actual verification evidence. Use specialists for
bounded independent review where useful. Never claim unrun checks passed.`,
  },
  debug: {
    label: "Debug",
    description: "Reproduce, diagnose, fix, and verify a defect.",
    prompt: `## DEBUG MODE
Reproduce the defect before editing. Trace the root cause, change one focused
area at a time, and rerun the failing check. Preserve existing behavior outside
the fix. State clearly when a failure could not be reproduced.`,
  },
  review: {
    label: "Review",
    description: "Review code for correctness, regressions, and security without editing.",
    prompt: `## REVIEW MODE
Perform a read-only code review. Prioritize correctness, security, data isolation,
reliability, performance, and test coverage. Report severity, file/line evidence,
impact, and a concrete remediation. Do not modify files or execute code.`,
  },
});

const READ_TOOLS = new Set([
  "read_file", "list_files", "web_search", "web_extract",
  "git_status", "git_diff", "git_log",
  "get_world_state", "get_terminal_context", "search_code",
  "grep_workspace", "glob_workspace", "find_definition", "find_usages",
  "analyze_code",
]);
const PLAN_TOOLS = new Set([...READ_TOOLS, "create_plan", "update_plan"]);
const EDIT_TOOLS = new Set([
  ...READ_TOOLS, "write_file", "edit_file", "compile_file",
  "verify_workspace", "run_tests", "start_preview", "get_preview_status",
  "stop_preview",
]);
const DEBUG_TOOLS = new Set([
  ...EDIT_TOOLS, "run_command", "browser_verify", "get_process_status",
  "get_terminal_output",
]);

export function normalizeAgentMode(mode) {
  return Object.hasOwn(AGENT_MODES, mode) ? mode : "agent";
}

export function getAgentModePrompt(mode) {
  return AGENT_MODES[normalizeAgentMode(mode)].prompt;
}

export function getAgentModes() {
  return Object.entries(AGENT_MODES).map(([value, item]) => ({
    value,
    label: item.label,
    description: item.description,
  }));
}

/**
 * Restrict tools exposed to and accepted from the model for the selected mode.
 * Explicit task-level allowlists (e.g. repo-agent specialists) are intersected.
 */
export function selectAgentTools(definitions, mode = "agent", explicitAllowedTools = null) {
  const selectedMode = normalizeAgentMode(mode);
  const modeAllowlist = selectedMode === "ask" || selectedMode === "review" ? READ_TOOLS
    : selectedMode === "plan" ? PLAN_TOOLS
      : selectedMode === "edit" ? EDIT_TOOLS
        : selectedMode === "debug" ? DEBUG_TOOLS
          : null;
  const explicit = Array.isArray(explicitAllowedTools) ? new Set(explicitAllowedTools) : null;
  return (definitions || []).filter(definition => {
    const name = definition?.function?.name;
    return typeof name === "string" &&
      (!modeAllowlist || modeAllowlist.has(name)) &&
      (!explicit || explicit.has(name));
  });
}
