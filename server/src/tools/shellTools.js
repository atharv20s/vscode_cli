/**
 * Shell Tools — Sandboxed Command Execution
 * 
 * Executes shell commands within the user's workspace using ExecutionService in
 * dedicated AGENT_BACKGROUND mode (isolated from the user's interactive PTY).
 */

import path from "path";
import { registerTool } from "./index.js";
import { config } from "../config/env.js";
import { executionService } from "../services/executionService.js";

/** Patterns that are blocked for safety. */
const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\//i,
  /format\s+[a-z]:/i,
  /del\s+\/s\s+\/q\s+[a-z]:\\/i,
  /mkfs/i,
  /dd\s+if=/i,
  /:(){ :|:& };:/,
  /shutdown/i,
  /reboot/i,
];

/**
 * Check if a command contains dangerous patterns.
 * @param {string} command
 * @returns {string | null} Block reason, or null if safe
 */
function checkCommandSafety(command) {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return `Command blocked: matches dangerous pattern ${pattern}`;
    }
  }
  return null;
}

export function registerShellTools() {
  registerTool(
    {
      type: "function",
      function: {
        name: "run_command",
        description:
          "Execute a shell command in the workspace directory and return its output. " +
          "Runs isolated in the background without interrupting the user's active terminal session. " +
          "Use for running scripts, installing packages, running tests, checking git, etc. " +
          "Dangerous commands (rm -rf /, format, etc.) are blocked.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The shell command to execute" },
            working_dir: {
              type: "string",
              description: "Optional working directory (relative to workspace)",
            },
            shell: {
              type: "string",
              description: "Shell environment to use: 'wsl' (Linux bash), 'powershell', or 'cmd'",
              enum: ["wsl", "powershell", "cmd"],
            },
          },
          required: ["command"],
        },
      },
    },
    async (args, ctx = {}) => {
      // 1. Safety pattern check
      const blockReason = checkCommandSafety(args.command);
      if (blockReason) {
        return { success: false, error: blockReason };
      }

      // 2. Resolve working directory
      const baseDir = ctx.workspaceDir || config.workspaceRoot;
      const cwd = args.working_dir ? path.resolve(baseDir, args.working_dir) : baseDir;

      // 3. Sandbox boundary validation
      const resolvedCwd = path.resolve(cwd);
      const resolvedWorkspace = path.resolve(baseDir);
      if (!resolvedCwd.startsWith(resolvedWorkspace)) {
        return { success: false, error: "Access denied: Target directory is outside the workspace root." };
      }

      // 4. Generate unique correlation operationId
      const operationId = `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

      // 5. Execute via ExecutionService in dedicated AGENT_BACKGROUND mode
      const result = await executionService.execute({
        command: args.command,
        cwd: resolvedCwd,
        mode: "AGENT_BACKGROUND",
        operationId,
        turnId: ctx.turnId || null,
        sessionId: ctx.sessionId || null,
        workspaceId: ctx.workspaceId || "default",
        shell: args.shell || "powershell",
        signal: ctx.signal || null,
      });

      if (result.success) {
        return { success: true, output: result.output, operationId };
      } else {
        return { success: false, error: result.output, exitCode: result.exitCode, operationId };
      }
    }
  );
}
