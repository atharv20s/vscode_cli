/**
 * Shell Tools — Sandboxed command execution.
 *
 * Executes shell commands within the user's workspace with:
 * - Configurable timeout
 * - Blocked dangerous command patterns
 * - stdout/stderr capture
 */

import { exec } from "child_process";
import { registerTool } from "./index.js";
import { config } from "../config/env.js";

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
          "Use for running scripts, installing packages, running tests, etc. " +
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
    async (args, ctx) => {
      // Safety check
      const blockReason = checkCommandSafety(args.command);
      if (blockReason) {
        return { success: false, error: blockReason };
      }

      const cwd = args.working_dir
        ? `${ctx.workspaceDir || config.workspaceRoot}/${args.working_dir}`
        : ctx.workspaceDir || config.workspaceRoot;

      const timeout = 30000; // 30 seconds
      const isWindows = process.platform === "win32";

      let finalCmd = args.command;
      if (args.shell === "wsl" && isWindows) {
        const winPath = cwd.replace(/\\/g, "/");
        const driveMatch = winPath.match(/^([A-Za-z]):\/(.*)/);
        const wslPath = driveMatch ? `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2]}` : winPath;
        const escaped = args.command.replace(/"/g, '\\"');
        finalCmd = `wsl.exe --cd "${wslPath}" -e bash -c "${escaped}"`;
      } else if (args.shell === "powershell" && isWindows) {
        finalCmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${args.command.replace(/"/g, '`"')}"`;
      }

      return new Promise((resolve) => {
        exec(
          finalCmd,
          { cwd, timeout, maxBuffer: 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error) {
              if (error.killed) {
                resolve({
                  success: false,
                  error: `Command timed out after ${timeout / 1000}s`,
                });
              } else {
                resolve({
                  success: false,
                  error: stderr || stdout || error.message,
                });
              }
            } else {
              const output = stdout.trim() || "(no output)";
              resolve({ success: true, output });
            }
          }
        );
      });
    }
  );
}
