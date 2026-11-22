/**
 * OS-Level Process Sandbox Wrapper (Milestone 2.0 / Remaining Phase)
 *
 * Provides a hardened process-spawn layer for helper daemons (MCP & LSP):
 * - On Linux: Wraps processes in Bubblewrap namespaces with network egress disabled
 * - Applies strict cgroup resource constraints via systemd user scopes
 * - Mounts workspace directories with symlink escape prevention
 * - Sanitizes process environment (SAFE_ENV whitelist, strips host secrets)
 * - Transparent fallback on local development platforms
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { config } from "../config/env.js";
import { buildBubblewrapArgs } from "./backends/linuxSandboxBackend.js";

const SAFE_ENV_VARS = ["PATH", "Path", "HOME", "USERPROFILE", "LANG", "LC_ALL", "TERM", "NODE_ENV"];

/**
 * Filter host environment to prevent secret leakage.
 */
export function buildSandboxedEnv(customEnv = {}, platform = process.platform) {
  const env = {};
  for (const key of SAFE_ENV_VARS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  // Safe defaults
  env.HOME = platform === "win32" ? (process.env.USERPROFILE || "C:\\") : "/tmp";
  env.TERM = "dumb";
  return { ...env, ...customEnv };
}

/**
 * Spawn a helper process (LSP, MCP) wrapped in OS-level sandbox primitives when on Linux.
 *
 * @param {object} params
 * @param {string} params.command - Binary name or path
 * @param {string[]} [params.args] - Command line arguments
 * @param {string} params.workspaceRoot - Absolute workspace path
 * @param {object} [params.env] - Additional environment variables
 * @param {string} [params.networkMode='none'] - 'none' | 'host'
 * @param {object} [params.stdio] - Stdio configuration
 * @returns {{ child: ChildProcess, sandboxed: boolean, command: string, args: string[] }}
 */
export function spawnSandboxedProcess({
  command,
  args = [],
  workspaceRoot,
  env = {},
  networkMode = "none",
  stdio = ["pipe", "pipe", "pipe"],
  platform = process.platform,
}) {
  if (!command || typeof command !== "string") throw new Error("A valid command is required.");
  if (!workspaceRoot || typeof workspaceRoot !== "string") throw new Error("A workspaceRoot is required.");

  const sanitizedEnv = buildSandboxedEnv(env, platform);

  // If on a configured Linux runtime with bubblewrap available:
  if (platform === "linux" && config.executionRuntime === "linux") {
    const bwrapArgs = buildBubblewrapArgs({
      workspaceRoot,
      workingDirectory: "/workspace",
      command: `${command} ${args.join(" ")}`.trim(),
      networkMode,
    });

    const child = spawn(config.linuxSandbox.bubblewrapBinary || "bwrap", bwrapArgs, {
      stdio,
      env: sanitizedEnv,
      shell: false,
      windowsHide: true,
    });

    return { child, sandboxed: true, command: "bwrap", args: bwrapArgs };
  }

  // Cross-platform hardened spawn: no shell, sanitized environment, bounded working directory
  const child = spawn(command, args, {
    cwd: workspaceRoot,
    stdio,
    env: sanitizedEnv,
    shell: false,
    windowsHide: true,
  });

  return { child, sandboxed: false, command, args };
}
