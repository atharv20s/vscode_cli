/**
 * Local Execution Backend & Shell Provider
 * 
 * Spawns real interactive shells on the host machine using node-pty,
 * dynamically discovers installed shells (PowerShell 7, Windows PowerShell, CMD, Git Bash, WSL),
 * and streams outputs wrapped in standardized event envelopes.
 */

import fs from "fs";
import path from "path";
import pty from "node-pty";
import { config } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { sendMessage } from "../../websocket/connectionManager.js";
import { eventBus, EVENT_TOPICS } from "../../websocket/eventBus.js";

/**
 * @typedef {Object} ShellProvider
 * @property {string} id
 * @property {string} name
 * @property {string} executable
 * @property {string[]} args
 * @property {string} platform
 */

export class LocalBackend {
  constructor() {
    this.ptyProcess = null;
  }

  /**
   * Dynamically detect available shells on the current operating system.
   * 
   * @returns {ShellProvider[]}
   */
  static detectAvailableShells() {
    const isWindows = process.platform === "win32";
    const shells = [];

    if (isWindows) {
      // 1. Windows PowerShell (always available on Windows)
      shells.push({
        id: "powershell",
        name: "Windows PowerShell",
        executable: "powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass"],
        platform: "win32",
      });

      // 2. Command Prompt
      shells.push({
        id: "cmd",
        name: "Command Prompt",
        executable: "cmd.exe",
        args: [],
        platform: "win32",
      });

      // 3. PowerShell 7 (pwsh.exe)
      const pwshPaths = [
        "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        "C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe",
      ];
      for (const p of pwshPaths) {
        if (fs.existsSync(p)) {
          shells.push({
            id: "pwsh",
            name: "PowerShell 7",
            executable: p,
            args: ["-NoProfile", "-ExecutionPolicy", "Bypass"],
            platform: "win32",
          });
          break;
        }
      }

      // 4. Git Bash
      const gitBashPaths = [
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
        path.join(process.env.LOCALAPPDATA || "", "Programs\\Git\\bin\\bash.exe"),
      ];
      for (const p of gitBashPaths) {
        if (fs.existsSync(p)) {
          shells.push({
            id: "git-bash",
            name: "Git Bash",
            executable: p,
            args: ["--login", "-i"],
            platform: "win32",
          });
          break;
        }
      }

      // 5. WSL (Windows Subsystem for Linux)
      const wslPath = "C:\\Windows\\System32\\wsl.exe";
      if (fs.existsSync(wslPath)) {
        shells.push({
          id: "wsl",
          name: "WSL (Linux)",
          executable: wslPath,
          args: [],
          platform: "win32",
        });
      }
    } else {
      // POSIX (Linux / macOS / Cloud Shell)
      const posixShells = [
        { id: "bash", name: "Bash", path: "/bin/bash" },
        { id: "zsh", name: "Zsh", path: "/bin/zsh" },
        { id: "sh", name: "Sh", path: "/bin/sh" },
      ];
      for (const s of posixShells) {
        if (fs.existsSync(s.path)) {
          shells.push({
            id: s.id,
            name: s.name,
            executable: s.path,
            args: ["--norc", "--noprofile", "-i"],
            platform: process.platform,
          });
        }
      }
    }

    return shells;
  }

  /**
   * Spawn a shell instance for the session.
   * 
   * @param {object} params
   * @param {string} params.sessionId
   * @param {string} [params.workspaceId='default']
   * @param {string} [params.shellType='powershell'] - Shell identifier
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
    const available = LocalBackend.detectAvailableShells();
    const matchedShell = available.find((s) => s.id === shellType) || available[0];

    let shellCmd = matchedShell.executable;
    let shellArgs = [...matchedShell.args];

    if (isWindows && shellType === "wsl") {
      const winPath = sessionCwd.replace(/\\/g, "/");
      const driveMatch = winPath.match(/^([A-Za-z]):\/(.*)/);
      const wslPath = driveMatch ? `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2]}` : winPath;
      shellArgs = ["--cd", wslPath];
    }

    logger.info(`LocalBackend: Spawning node-pty process for session ${sessionId}: ${shellCmd} in ${sessionCwd}`);

    // Build clean sanitized virtual environment
    const sanitizedEnv = isWindows
      ? { ...process.env, TERM: "xterm-256color" }
      : {
          PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          LANG: "en_US.UTF-8",
          HOME: sessionCwd,
          PWD: sessionCwd,
          PS1: "\\[\\033[01;36m\\]workspace\\[\\033[00m\\]:\\[\\033[01;34m\\]~/project\\[\\033[00m\\]$ ",
          PROMPT_COMMAND: "",
        };

    try {
      this.ptyProcess = pty.spawn(shellCmd, shellArgs, {
        name: "xterm-256color",
        cols: cols || 80,
        rows: rows || 24,
        cwd: sessionCwd,
        env: sanitizedEnv,
      });

      // Stream PTY output to the EventBus and WebSocket
      this.ptyProcess.onData((data) => {
        eventBus.publish(EVENT_TOPICS.TERMINAL_OUTPUT, {
          data,
          sessionId,
          workspaceId,
        }, {
          sessionId,
          workspaceId,
          source: "pty",
          actor: "user",
        });

        if (ws) {
          sendMessage(ws, "terminal.output", { text: data, sessionId });
          sendMessage(ws, "terminal_output", { text: data, sessionId });
        }
      });

      this.ptyProcess.onExit(({ exitCode, signal }) => {
        logger.info(`LocalBackend: PTY process exited for session ${sessionId} (Code: ${exitCode})`);

        eventBus.publish(EVENT_TOPICS.TERMINAL_EXIT, {
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
          text: `[System] Interactive terminal session started (${matchedShell.name})\r\n`,
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
   * Dangerous host escape and command injection patterns to block.
   */
  static isDangerousCommand(input) {
    if (typeof input !== "string") return false;
    const lower = input.toLowerCase();
    const blocked = [
      "metadata.google.internal",
      "gcloud auth",
      "gcloud compute",
      "rm -rf /",
      "rm -rf /*",
      "rm -rf /home",
      "rm -rf /etc",
      "rm -rf /usr",
      "mkfs.",
      "killall node",
      "killall -9 node",
      "pkill -9 node",
      "/etc/shadow",
      ":(){ :|:& };:",
    ];
    return blocked.some((b) => lower.includes(b));
  }

  /**
   * Write input data/keystrokes to the shell's stdin.
   */
  write(sessionId, data) {
    if (!this.ptyProcess) return;

    if (LocalBackend.isDangerousCommand(data)) {
      logger.warn(`Blocked dangerous terminal input from session ${sessionId}: ${data}`);
      if (this.ptyProcess) {
        this.ptyProcess.write("\x03"); // send Ctrl+C
      }
      return;
    }

    this.ptyProcess.write(data);
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
