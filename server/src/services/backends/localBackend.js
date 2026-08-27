/**
 * Local Execution Backend
 * 
 * Spawns real interactive shells on the host machine using node-pty,
 * streaming outputs wrapped in standardized event envelopes.
 */

import pty from "node-pty";
import { config } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { sendMessage } from "../../websocket/connectionManager.js";
import { eventBus } from "../../websocket/eventBus.js";

export class LocalBackend {
  constructor() {
    this.ptyProcess = null;
  }

  /**
   * Spawn a shell instance for the session.
   * 
   * @param {object} params
   * @param {string} params.sessionId
   * @param {string} [params.workspaceId='default']
   * @param {string} [params.shellType='powershell'] - "powershell" | "cmd" | "wsl"
   * @param {number} [params.cols=80]
   * @param {number} [params.rows=24]
   * @param {string} [params.cwd]
   * @param {import('ws').WebSocket} params.ws
   * @param {Function} [params.onExit]
   * @returns {Promise<any>} The spawned PTY process
   */
  async spawnShell({ sessionId, workspaceId = "default", shellType = "powershell", cols = 80, rows = 24, cwd, ws, onExit }) {
    const isWindows = process.platform === "win32";
    const sessionCwd = cwd || config.workspaceRoot;
    let shellCmd = "";
    let shellArgs = [];

    if (isWindows) {
      if (shellType === "wsl") {
        shellCmd = "wsl.exe";
        const winPath = sessionCwd.replace(/\\/g, "/");
        const driveMatch = winPath.match(/^([A-Za-z]):\/(.*)/);
        const wslPath = driveMatch ? `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2]}` : winPath;
        shellArgs = ["--cd", wslPath];
      } else if (shellType === "cmd") {
        shellCmd = "cmd.exe";
      } else {
        shellCmd = "powershell.exe";
        shellArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass"];
      }
    } else {
      shellCmd = "bash";
    }

    logger.info(`LocalBackend: Spawning node-pty process for session ${sessionId}: ${shellCmd} in ${sessionCwd}`);

    try {
      this.ptyProcess = pty.spawn(shellCmd, shellArgs, {
        name: "xterm-256color",
        cols: cols || 80,
        rows: rows || 24,
        cwd: sessionCwd,
        env: { ...process.env, TERM: "xterm-256color" }
      });

      // Stream PTY output to the EventBus and WebSocket
      this.ptyProcess.onData((data) => {
        // Publish event to the EventBus with full envelope
        eventBus.publish("terminal.output", {
          data,
          sessionId,
          workspaceId,
        }, {
          sessionId,
          workspaceId,
          source: "pty",
          actor: "user",
        });

        // Forward to the connected client UI
        if (ws) {
          sendMessage(ws, "terminal.output", { text: data, sessionId });
          sendMessage(ws, "terminal_output", { text: data, sessionId }); // Fallback compatibility
        }
      });

      this.ptyProcess.onExit(({ exitCode, signal }) => {
        logger.info(`LocalBackend: PTY process exited for session ${sessionId} (Code: ${exitCode})`);
        
        eventBus.publish("terminal.exit", {
          code: exitCode,
          signal,
          sessionId,
          workspaceId,
        }, {
          sessionId,
          workspaceId,
          source: "pty",
          actor: "system",
        });

        if (ws) {
          sendMessage(ws, "terminal.exit", { code: exitCode, sessionId });
          sendMessage(ws, "terminal_exit", { code: exitCode, sessionId });
        }

        if (typeof onExit === "function") {
          onExit(exitCode);
        }
      });

      // Initial confirmation message
      if (ws) {
        sendMessage(ws, "terminal.output", { 
          text: `[System] Interactive terminal session started (${shellType.toUpperCase()})\r\n`,
          sessionId,
        });
      }

      return this.ptyProcess;
    } catch (err) {
      logger.error(`LocalBackend spawn error: ${err.message}`);
      if (ws) {
        sendMessage(ws, "terminal.output", { 
          text: `Failed to spawn shell: ${err.message}\r\n`,
          sessionId,
        });
      }
      throw err;
    }
  }

  /**
   * Write input commands/keystrokes to the shell's stdin.
   */
  write(sessionId, data) {
    if (this.ptyProcess) {
      this.ptyProcess.write(data);
    }
  }

  /**
   * Resize shell layout columns and rows.
   */
  resize(sessionId, cols, rows) {
    if (this.ptyProcess && typeof this.ptyProcess.resize === "function") {
      try {
        this.ptyProcess.resize(cols || 80, rows || 24);
      } catch (err) {
        logger.error(`LocalBackend resize failed: ${err.message}`);
      }
    }
  }

  /**
   * Terminate the shell.
   */
  kill(sessionId) {
    if (this.ptyProcess) {
      try {
        this.ptyProcess.kill();
      } catch {}
      this.ptyProcess = null;
    }
  }
}
