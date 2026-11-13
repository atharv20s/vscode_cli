import { registerTool } from "./index.js";

const ROLE_CAPABILITIES = {
  planner: ["read_file","list_files","create_plan"],
  frontend: ["read_file","list_files","write_file","edit_file","run_command"],
  backend: ["read_file","list_files","write_file","edit_file","run_command"],
  coder: ["read_file","list_files","write_file","edit_file","run_command"],
  tester: ["read_file","list_files","run_command","git_status","git_diff"],
  reviewer: ["read_file","list_files","git_status","git_diff"],
  security_reviewer: ["read_file","list_files","git_status","git_diff"],
};

const ROLE_GUIDANCE = {
  planner: "Inspect the workspace and produce an actionable plan. Do not modify source files.",
  frontend: "Own frontend implementation only. Respect existing design system, accessibility, responsive behavior and API contracts. Avoid backend/database changes.",
  backend: "Own backend and API implementation only. Preserve frontend contracts, validate input, enforce authorization and add focused tests.",
  coder: "Implement the assigned task using the smallest coherent changes. Inspect callers and add regression tests.",
  tester: "Independently run relevant tests and report exact commands, exit codes and output. Do not modify source files.",
  reviewer: "Independently inspect actual changed files and diffs. Identify correctness, security, compatibility and maintainability blockers. Do not edit.",
  security_reviewer: "Perform a security-focused review of changed code, especially authentication, authorization, secrets, path traversal, command execution, SSRF and workspace isolation. Do not edit.",
};

export function getSpecialistCapabilities(role) {
  return ROLE_CAPABILITIES[role] ? [...ROLE_CAPABILITIES[role]] : [];
}

export function registerSpecialistTools() {
  registerTool({
    type: "function",
    function: {
      name: "delegate_specialist",
      description: "Delegate a bounded subtask to a specialist LLM agent in the current workspace. Delegation runs sequentially to prevent concurrent file-write conflicts. Use planner before complex work, separate frontend/backend specialists for clearly separable concerns, then tester and reviewer.",
      parameters: {
        type: "object",
        properties: {
          role: { type: "string", enum: Object.keys(ROLE_CAPABILITIES), description: "Specialist role" },
          task: { type: "string", description: "Specific bounded assignment with expected outputs and constraints" },
          context: { type: "string", description: "Relevant plan, contracts or findings from previous agents" },
          max_iterations: { type: "integer", minimum: 1, maximum: 12, description: "Maximum specialist tool-calling turns" },
        },
        required: ["role","task"],
      },
    },
  }, async (args, ctx = {}) => {
    const role = String(args.role || "");
    const capabilities = getSpecialistCapabilities(role);
    const task = String(args.task || "").trim();
    if (!capabilities.length || !task) return { success: false, error: "A supported specialist role and non-empty task are required." };
    if (!ctx.workspaceDir || !ctx.workspaceService) return { success: false, error: "Specialist delegation requires an active, scoped workspace." };
    if (ctx.signal?.aborted) return { success: false, error: "Parent task was cancelled." };

    const { runAgent } = await import("../services/agentService.js");
    const events = [];
    let finalText = "";
    let failure = null;
    const result = await runAgent({
      message: [
        "SPECIALIST ASSIGNMENT",
        "Role: " + role,
        ROLE_GUIDANCE[role],
        "Work only on this assignment. Do not expand scope or claim unverified success.",
        "Assignment:\n" + task,
        args.context ? "Parent-agent context:\n" + String(args.context).slice(0, 12000) : "",
        "When finished, report changed files, commands actually run, results and blockers.",
      ].filter(Boolean).join("\n\n"),
      workspaceDir: ctx.workspaceDir,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      workspaceService: ctx.workspaceService,
      persistWorkspaceMeta: false,
      allowedTools: capabilities,
      maxIterations: Math.min(12, Math.max(1, Number(args.max_iterations) || 8)),
      model: role === "planner" || role === "reviewer" || role === "security_reviewer" ? "reasoning" : role === "tester" ? "fast" : "coding",
      signal: ctx.signal,
      onEvent: event => {
        if (event.type === "text_complete" && event.data?.content) finalText = event.data.content;
        if (event.type === "error") failure = event.data?.message || "Specialist failed.";
        ctx.onEvent?.({ ...event, data: { ...(event.data || {}), specialistRole: role } });
      },
    });
    if (!finalText) {
      const messages = result?.messages || [];
      finalText = messages.filter(item => item.role === "assistant" && typeof item.content === "string").at(-1)?.content || "";
    }
    return {
      success: !failure && !result?.aborted,
      output: finalText || "Specialist completed without a text summary.",
      error: failure || (result?.aborted ? "Specialist was cancelled." : undefined),
      role,
      capabilities,
      totalTokens: result?.totalTokens || 0,
    };
  });
}
