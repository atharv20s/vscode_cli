/**
 * Terminal Manager
 * 
 * Manages persistent terminal/shell processes associated with active WebSocket connections.
 * Uses node-pty to spawn real pseudo-terminals for interactive terminal emulators like Xterm.js.
 */

import pty from "node-pty";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import { sendMessage } from "./connectionManager.js";

/** @type {Map<import('ws').WebSocket, any>} */
const activeShells = new Map();

/**
 * Initialize a persistent terminal process for a WebSocket.
 * Terminates any existing shell for this connection first.
 * 
 * @param {import('ws').WebSocket} ws
 * @param {string} shellType - "powershell" | "cmd" | "wsl"
 * @param {number} cols - Terminal columns count
 * @param {number} rows - Terminal rows count
 */
export function initTerminal(ws, shellType = "powershell", cols = 80, rows = 24) {
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

  logger.info(`Spawning node-pty shell: ${shellCmd} ${shellArgs.join(" ")} in ${config.workspaceRoot}`);

  try {
    const ptyProcess = pty.spawn(shellCmd, shellArgs, {
      name: "xterm-color",
      cols: cols || 80,
      rows: rows || 24,
      cwd: config.workspaceRoot,
      env: { ...process.env, TERM: "xterm-color" }
    });

    activeShells.set(ws, ptyProcess);

    // 2. Stream output back to WebSocket
    ptyProcess.onData((data) => {
      sendMessage(ws, "terminal_output", { text: data });
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      logger.info(`PTY process exited with code ${exitCode}, signal ${signal}`);
      sendMessage(ws, "terminal_exit", { code: exitCode });
      if (activeShells.get(ws) === ptyProcess) {
        activeShells.delete(ws);
      }
    });

    // Provide initial system acknowledgement
    sendMessage(ws, "terminal_output", { 
      text: `[System] Interactive terminal session started (${shellType.toUpperCase()})\r\n` 
    });

  } catch (err) {
    logger.error(`Failed to start PTY terminal: ${err.message}`);
    sendMessage(ws, "terminal_output", { text: `Failed to start terminal: ${err.message}\r\n` });
  }
}

/**
 * Handle input data from the client, writing it to the shell's stdin.
 * 
 * @param {import('ws').WebSocket} ws
 * @param {string} input - Text input from terminal (typically command + newline)
 */
export function handleTerminalInput(ws, input) {
  const ptyProcess = activeShells.get(ws);
  if (ptyProcess) {
    ptyProcess.write(input);
  } else {
    sendMessage(ws, "terminal_output", { text: "Error: No active terminal process.\r\n" });
  }
}

/**
 * Resize the terminal dimensions.
 * 
 * @param {import('ws').WebSocket} ws
 * @param {number} cols
 * @param {number} rows
 */
export function resizeTerminal(ws, cols, rows) {
  const ptyProcess = activeShells.get(ws);
  if (ptyProcess && typeof ptyProcess.resize === "function") {
    try {
      ptyProcess.resize(cols || 80, rows || 24);
    } catch (err) {
      logger.error(`Failed to resize terminal: ${err.message}`);
    }
  }
}

/**
 * Terminate terminal process associated with a WebSocket.
 * 
 * @param {import('ws').WebSocket} ws
 */
export function killTerminal(ws) {
  const ptyProcess = activeShells.get(ws);
  if (ptyProcess) {
    try {
      ptyProcess.kill();
    } catch {}
    activeShells.delete(ws);
  }
}
