/**
 * Execution Service
 * 
 * Central controller abstracting command execution across distinct modes:
 * - USER_INTERACTIVE: User's primary xterm.js PTY shell.
 * - AGENT_BACKGROUND: Dedicated, non-interactive process for AI agent commands.
 * - AGENT_INTERACTIVE: Dedicated interactive agent PTY shell.
 * 
 * Connects to eventBus with standardized event envelopes and correlation IDs.
 */

import { spawn } from "child_process";
import { logger } from "../config/logger.js";
import { config } from "../config/env.js";
import { eventBus } from "../websocket/eventBus.js";
import { terminalSessionManager } from "./terminalSessionManager.js";

/**
 * @typedef {'USER_INTERACTIVE' | 'AGENT_BACKGROUND' | 'AGENT_INTERACTIVE'} ExecutionMode
 */

class ExecutionService {
  constructor() {
    this.activeBackgroundTasks = new Map(); // operationId -> ChildProcess
  }

  /**
   * Spawn a user interactive shell session.
   */
  async spawnInteractiveSession(sessionId, options = {}) {
    return terminalSessionManager.createSession(sessionId, options);
  }

  /**
   * Write to a user interactive terminal session.
   */
  writeInteractive(sessionId, data) {
    return terminalSessionManager.write(sessionId, data);
  }

  /**
   * Resize a user interactive terminal session.
   */
  resizeInteractive(sessionId, cols, rows) {
    return terminalSessionManager.resize(sessionId, cols, rows);
  }

  /**
   * Terminate a user interactive terminal session.
   */
  killInteractive(sessionId) {
    return terminalSessionManager.destroySession(sessionId);
  }

  /**
   * Execute a command with the specified execution mode.
   * 
   * @param {object} params
   * @param {string} params.command - Command line to execute
   * @param {string} [params.cwd] - Working directory
   * @param {ExecutionMode} [params.mode='AGENT_BACKGROUND'] - Execution mode
   * @param {string} [params.operationId] - Operation correlation ID
   * @param {string} [params.turnId] - Agent turn ID
   * @param {string} [params.sessionId] - Session ID
   * @param {string} [params.workspaceId='default'] - Workspace ID
   * @param {string} [params.shell='powershell'] - Shell type ('powershell', 'cmd', 'wsl')
   * @param {number} [params.timeout=45000] - Execution timeout in ms
   * @param {AbortSignal} [params.signal] - Abort controller signal
   * @returns {Promise<{ success: boolean, output: string, exitCode: number }>}
   */
  async execute({
    command,
    cwd = config.workspaceRoot,
    mode = "AGENT_BACKGROUND",
    operationId = `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    turnId = null,
    sessionId = null,
    workspaceId = "default",
    shell = "powershell",
    timeout = 45000,
    signal = null,
  }) {
    // Mode 1: USER_INTERACTIVE (Write directly into active user PTY session)
    if (mode === "USER_INTERACTIVE") {
      if (!sessionId) {
        throw new Error("Cannot execute in USER_INTERACTIVE mode: missing sessionId.");
      }
      terminalSessionManager.write(sessionId, command + "\r");
      return { success: true, output: `Command sent to user interactive terminal.`, exitCode: 0 };
    }

    // Mode 2: AGENT_BACKGROUND (Isolated, dedicated non-interactive process runner)
    const startTime = Date.now();

    // 1. Emit agent.command.started
    eventBus.publish("agent.command.started", {
      command,
      cwd,
      mode,
    }, {
      workspaceId,
      sessionId,
      turnId,
      operationId,
      source: "agent",
      actor: "agent",
    });

    logger.info(`ExecutionService: Starting AGENT_BACKGROUND command [${operationId}]: ${command} in ${cwd}`);

    const isWindows = process.platform === "win32";
    let shellExecutable = "powershell.exe";
    let shellArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command];

    if (isWindows) {
      if (shell === "wsl") {
        const winPath = cwd.replace(/\\/g, "/");
        const driveMatch = winPath.match(/^([A-Za-z]):\/(.*)/);
        const wslPath = driveMatch ? `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2]}` : winPath;
        const escaped = command.replace(/"/g, '\\"');
        shellExecutable = "wsl.exe";
        shellArgs = ["--cd", wslPath, "-e", "bash", "-c", escaped];
      } else if (shell === "cmd") {
        shellExecutable = "cmd.exe";
        shellArgs = ["/c", command];
      }
    } else {
      shellExecutable = "bash";
      shellArgs = ["-c", command];
    }

    return new Promise((resolve) => {
      let outputBuffer = "";
      let isSettled = false;

      let child;
      try {
        child = spawn(shellExecutable, shellArgs, {
          cwd,
          env: { ...process.env, TERM: "dumb" },
          windowsHide: true,
        });
      } catch (err) {
        const durationMs = Date.now() - startTime;
        eventBus.publish("agent.command.completed", {
          command,
          exitCode: 1,
          durationMs,
          error: err.message,
        }, {
          workspaceId,
          sessionId,
          turnId,
          operationId,
          source: "agent",
          actor: "agent",
        });

        return resolve({ success: false, output: err.message, exitCode: 1 });
      }

      this.activeBackgroundTasks.set(operationId, child);

      // Handle timeout
      const timeoutTimer = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          try {
            child.kill();
          } catch {}
          this.activeBackgroundTasks.delete(operationId);

          const durationMs = Date.now() - startTime;
          const msg = `Command timed out after ${timeout / 1000}s.`;
          
          eventBus.publish("agent.command.completed", {
            command,
            exitCode: -1,
            durationMs,
            error: msg,
          }, {
            workspaceId,
            sessionId,
            turnId,
            operationId,
            source: "agent",
            actor: "agent",
          });

          resolve({ success: false, output: msg, exitCode: -1 });
        }
      }, timeout);

      // Handle abort signal
      if (signal) {
        signal.addEventListener("abort", () => {
          if (!isSettled) {
            isSettled = true;
            clearTimeout(timeoutTimer);
            try {
              child.kill();
            } catch {}
            this.activeBackgroundTasks.delete(operationId);

            resolve({ success: false, output: "Command aborted by user.", exitCode: -1 });
          }
        });
      }

      // Stream stdout chunks
      child.stdout.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        outputBuffer += text;

        eventBus.publish("agent.command.output", {
          data: text,
          stream: "stdout",
        }, {
          workspaceId,
          sessionId,
          turnId,
          operationId,
          source: "agent",
          actor: "agent",
        });
      });

      // Stream stderr chunks
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        outputBuffer += text;

        eventBus.publish("agent.command.output", {
          data: text,
          stream: "stderr",
        }, {
          workspaceId,
          sessionId,
          turnId,
          operationId,
          source: "agent",
          actor: "agent",
        });
      });

      child.on("close", (code) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timeoutTimer);
          this.activeBackgroundTasks.delete(operationId);

          const durationMs = Date.now() - startTime;
          const exitCode = code ?? 0;
          const success = exitCode === 0;

          eventBus.publish("agent.command.completed", {
            command,
            exitCode,
            durationMs,
            output: outputBuffer.trim(),
          }, {
            workspaceId,
            sessionId,
            turnId,
            operationId,
            source: "agent",
            actor: "agent",
          });

          logger.info(`ExecutionService: Finished command [${operationId}] (Exit: ${exitCode}, Duration: ${durationMs}ms)`);

          resolve({
            success,
            output: outputBuffer.trim() || (success ? "(completed with no output)" : `Command exited with code ${exitCode}`),
            exitCode,
          });
        }
      });

      child.on("error", (err) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timeoutTimer);
          this.activeBackgroundTasks.delete(operationId);

          const durationMs = Date.now() - startTime;
          
          eventBus.publish("agent.command.completed", {
            command,
            exitCode: 1,
            durationMs,
            error: err.message,
          }, {
            workspaceId,
            sessionId,
            turnId,
            operationId,
            source: "agent",
            actor: "agent",
          });

          resolve({ success: false, output: err.message, exitCode: 1 });
        }
      });
    });
  }

  /**
   * Stop an active background command.
   */
  stopBackgroundTask(operationId) {
    const child = this.activeBackgroundTasks.get(operationId);
    if (child) {
      try {
        child.kill();
      } catch {}
      this.activeBackgroundTasks.delete(operationId);
      logger.info(`ExecutionService: Stopped background task ${operationId}`);
      return true;
    }
    return false;
  }
}

export const executionService = new ExecutionService();
