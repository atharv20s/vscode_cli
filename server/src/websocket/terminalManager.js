/**
 * Terminal Manager
 * 
 * Manages persistent terminal/shell processes associated with active WebSocket connections.
 * Allows executing interactive commands (e.g., cd, pip, python) by piping stdin/stdout.
 */

import { spawn } from "child_process";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import { sendMessage } from "./connectionManager.js";

/** @type {Map<import('ws').WebSocket, import('child_process').ChildProcess>} */
const activeShells = new Map();

/**
 * Initialize a persistent terminal process for a WebSocket.
 * Terminates any existing shell for this connection first.
 * 
 * @param {import('ws').WebSocket} ws
 * @param {string} shellType - "powershell" | "cmd" | "wsl"
 */
export function initTerminal(ws, shellType = "powershell") {
  // 1. Clean up existing process if any
  killTerminal(ws);

  const isWindows = process.platform === "win32";
  let shellCmd = "";
  let shellArgs = [];

  if (isWindows) {
    if (shellType === "wsl") {
      shellCmd = "wsl.exe";
      // Convert Windows workspace root path to WSL path
      const winPath = config.workspaceRoot.replace(/\\/g, "/");
      const driveMatch = winPath.match(/^([A-Za-z]):\/(.*)/);
      const wslPath = driveMatch ? `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2]}` : winPath;
      shellArgs = ["--cd", wslPath];
    } else if (shellType === "cmd") {
      shellCmd = "cmd.exe";
    } else {
      // Default to powershell
      shellCmd = "powershell.exe";
      shellArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass"];
    }
  } else {
    // Unix fallback
    shellCmd = "bash";
  }

  logger.info(`Spawning interactive shell: ${shellCmd} ${shellArgs.join(" ")} in ${config.workspaceRoot}`);

  try {
    const shellProcess = spawn(shellCmd, shellArgs, {
      cwd: config.workspaceRoot,
      env: { ...process.env, TERM: "xterm-color" },
      shell: true, // Use shell execution for best compatibility
    });

    activeShells.set(ws, shellProcess);

    // 2. Stream output back to WebSocket
    shellProcess.stdout.on("data", (data) => {
      sendMessage(ws, "terminal_output", { text: data.toString("utf8") });
    });

    shellProcess.stderr.on("data", (data) => {
      sendMessage(ws, "terminal_output", { text: data.toString("utf8") });
    });

    shellProcess.on("close", (code) => {
      logger.info(`Terminal process closed with code ${code}`);
      sendMessage(ws, "terminal_exit", { code });
      if (activeShells.get(ws) === shellProcess) {
        activeShells.delete(ws);
      }
    });

    shellProcess.on("error", (err) => {
      logger.error(`Terminal spawn error: ${err.message}`);
      sendMessage(ws, "terminal_output", { text: `Terminal Error: ${err.message}\n` });
    });

    // Provide initial welcoming hint
    sendMessage(ws, "terminal_output", { 
      text: `[System] Interactive terminal session started (${shellType.toUpperCase()})\n` 
    });

  } catch (err) {
    logger.error(`Failed to start terminal: ${err.message}`);
    sendMessage(ws, "terminal_output", { text: `Failed to start terminal: ${err.message}\n` });
  }
}

/**
 * Handle input data from the client, writing it to the shell's stdin.
 * 
 * @param {import('ws').WebSocket} ws
 * @param {string} input - Text input from terminal (typically command + newline)
 */
export function handleTerminalInput(ws, input) {
  const proc = activeShells.get(ws);
  if (proc && proc.stdin && proc.stdin.writable) {
    proc.stdin.write(input);
  } else {
    sendMessage(ws, "terminal_output", { text: "Error: No active terminal process.\n" });
  }
}

/**
 * Terminate terminal process associated with a WebSocket.
 * 
 * @param {import('ws').WebSocket} ws
 */
export function killTerminal(ws) {
  const proc = activeShells.get(ws);
  if (proc) {
    try {
      proc.kill("SIGTERM");
      // Hard kill if still alive in 2 seconds
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }, 2000);
    } catch {}
    activeShells.delete(ws);
  }
}
