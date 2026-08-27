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
          "Execute a non-interactive shell command in the workspace directory and return its output. " +
          "Runs isolated in the background without interrupting the user's active terminal session. " +
          "Do not run interactive REPLs (like bare 'python' or bare 'node'); instead pass a script or flags (e.g. python -c '...' or node script.js). " +
          "For persistent dev servers, use start_preview.",
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
            timeout_seconds: {
              type: "number",
              description: "Timeout in seconds (default 60, max 300)",
            },
          },
          required: ["command"],
        },
      },
    },
    async (args, ctx = {}) => {
      const trimmedCmd = (args.command || "").trim();

      // Guard against bare interactive REPLs that hang indefinitely
      if (/^(python|python3|py|node|irb|php -a|bash|sh|powershell|pwsh|cmd)$/i.test(trimmedCmd)) {
        return {
          success: false,
          error:
            `Interactive REPL detected ('${trimmedCmd}'). run_command executes non-interactively in background. ` +
            `Please specify a script or one-liner (e.g. 'python -c "..."' or 'node -e "..."' or 'python file.py').`,
        };
      }

      // Guard against persistent web servers invoked in run_command instead of start_preview
      if (/^(npm run dev|npm start|vite|npx vite|python -m http\.server|http-server)/i.test(trimmedCmd)) {
        return {
          success: false,
          error:
            `Persistent server detected ('${trimmedCmd}'). For long-running preview servers, please use the 'start_preview' tool so it is tracked and managed properly without timing out.`,
        };
      }

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
      const timeoutMs = Math.min(Math.max((args.timeout_seconds || 60) * 1000, 5000), 300000);

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
        timeout: timeoutMs,
        signal: ctx.signal || null,
      });

      if (result.success) {
        return { success: true, output: result.output, operationId };
      } else {
        return { success: false, error: result.output || result.error, exitCode: result.exitCode, operationId };
      }
    }
  );
}
