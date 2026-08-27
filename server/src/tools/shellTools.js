/**
 * Shell Tools — Sandboxed Command Execution
 * 
 * Routes through PermissionEngine for security policy checks and executes
 * in isolated AGENT_BACKGROUND mode via ExecutionService & ProcessSupervisor.
 */

import path from "path";
import { registerTool } from "./index.js";
import { config } from "../config/env.js";
import { executionService } from "../services/executionService.js";
import { permissionEngine } from "../services/permissionEngine.js";

export function registerShellTools() {
  registerTool(
    {
      type: "function",
      function: {
        name: "run_command",
        description:
          "Execute a shell command in the workspace directory and return its output. " +
          "Runs isolated in the background without interrupting the user's active terminal session.",
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
              description: "Shell environment: 'powershell', 'pwsh', 'cmd', 'git-bash', 'wsl'",
              enum: ["powershell", "pwsh", "cmd", "git-bash", "wsl"],
            },
          },
          required: ["command"],
        },
      },
    },
    async (args, ctx = {}) => {
      // 1. Permission Engine Evaluation (DENY > ASK > ALLOW)
      const perm = await permissionEngine.checkPermission({
        resource: "command",
        action: "execute",
        payload: { command: args.command, working_dir: args.working_dir, shell: args.shell },
        turnId: ctx.turnId,
        sessionId: ctx.sessionId,
      });

      if (!perm.granted) {
        return { success: false, error: perm.reason || "Execution blocked by permission policy." };
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
