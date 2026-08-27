/**
 * Process Supervisor
 * 
 * Manages, tracks, and supervises all background agent execution processes.
 * Enforces execution timeouts, assigns correlation IDs, handles cross-platform
 * process tree termination to prevent orphaned processes from holding ports,
 * and publishes formalized agent.command.* lifecycle events.
 */

import { spawn, exec } from "child_process";
import { logger } from "../config/logger.js";
import { config } from "../config/env.js";
import { eventBus, EVENT_TOPICS } from "../websocket/eventBus.js";

/**
 * Cross-platform process tree killer.
 * Ensures child subprocesses (e.g. Node, Vite, Python) spawned by the shell are killed.
 * 
 * @param {number} pid - Process ID
 * @returns {Promise<void>}
 */
export function killProcessTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();

    const isWindows = process.platform === "win32";

    if (isWindows) {
      exec(`taskkill /pid ${pid} /t /f`, (err) => {
        if (err) {
          logger.debug(`ProcessSupervisor: taskkill notice for PID ${pid}: ${err.message}`);
        }
        resolve();
      });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      resolve();
    }
  });
}

class ProcessSupervisor {
  constructor() {
    /** @type {Map<string, { operationId: string, command: string, cwd: string, pid: number|null, startTime: number, child: any, turnId: string|null, sessionId: string|null, workspaceId: string }>} */
    this.activeProcesses = new Map();
  }

  /**
   * Execute an isolated background command under full supervision.
   * 
   * @param {object} params
   * @param {string} params.command - Command line to execute
   * @param {string} [params.cwd] - Working directory
   * @param {string} [params.shell='powershell'] - 'powershell' | 'cmd' | 'wsl'
   * @param {number} [params.timeout=45000] - Timeout in ms
   * @param {AbortSignal} [params.signal] - Optional abort signal
   * @param {string} [params.operationId] - Correlation operation identifier
   * @param {string} [params.turnId] - Correlation agent turn identifier
   * @param {string} [params.sessionId] - Active session identifier
   * @param {string} [params.workspaceId='default'] - Workspace identifier
   * @returns {Promise<{ success: boolean, output: string, exitCode: number, operationId: string }>}
   */
  async execute({
    command,
    cwd = config.workspaceRoot,
    shell = "powershell",
    timeout = 45000,
    signal = null,
    operationId = `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    turnId = null,
    sessionId = null,
    workspaceId = "default",
  }) {
    const startTime = Date.now();

    // 1. Emit agent.command.requested
    eventBus.publish(EVENT_TOPICS.AGENT_COMMAND_REQUESTED, {
      command,
      cwd,
      shell,
    }, {
      workspaceId,
      sessionId,
      turnId,
      operationId,
      source: "agent",
      actor: "agent",
    });

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
        eventBus.publish(EVENT_TOPICS.AGENT_COMMAND_FAILED, {
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

        return resolve({ success: false, output: err.message, exitCode: 1, operationId });
      }

      const pid = child.pid || null;

      // Register process
      this.activeProcesses.set(operationId, {
        operationId,
        command,
        cwd,
        pid,
        startTime,
        child,
        turnId,
        sessionId,
        workspaceId,
      });

      // 2. Emit agent.command.started
      eventBus.publish(EVENT_TOPICS.AGENT_COMMAND_STARTED, {
        command,
        cwd,
        pid,
      }, {
        workspaceId,
        sessionId,
        turnId,
        operationId,
        source: "agent",
        actor: "agent",
      });

      logger.info(`ProcessSupervisor: Started process [${operationId}] (PID: ${pid}): ${command}`);

      // Timeout supervisor
      const timeoutTimer = setTimeout(async () => {
        if (!isSettled) {
          isSettled = true;
          await killProcessTree(pid);
          this.activeProcesses.delete(operationId);

          const durationMs = Date.now() - startTime;
          const msg = `Command timed out after ${timeout / 1000}s.`;

          eventBus.publish(EVENT_TOPICS.AGENT_COMMAND_FAILED, {
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

          resolve({ success: false, output: msg, exitCode: -1, operationId });
        }
      }, timeout);

      // Abort signal listener
      if (signal) {
        signal.addEventListener("abort", async () => {
          if (!isSettled) {
            isSettled = true;
            clearTimeout(timeoutTimer);
            await killProcessTree(pid);
            this.activeProcesses.delete(operationId);

            resolve({ success: false, output: "Command aborted by user.", exitCode: -1, operationId });
          }
        });
      }

      // Stream stdout chunks
      child.stdout.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        outputBuffer += text;

        eventBus.publish(EVENT_TOPICS.AGENT_COMMAND_OUTPUT, {
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

        eventBus.publish(EVENT_TOPICS.AGENT_COMMAND_OUTPUT, {
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
          this.activeProcesses.delete(operationId);

          const durationMs = Date.now() - startTime;
          const exitCode = code ?? 0;
          const success = exitCode === 0;

          if (success) {
            eventBus.publish(EVENT_TOPICS.AGENT_COMMAND_COMPLETED, {
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
          } else {
            eventBus.publish(EVENT_TOPICS.AGENT_COMMAND_FAILED, {
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
          }

          logger.info(`ProcessSupervisor: Settled process [${operationId}] (Exit: ${exitCode}, Duration: ${durationMs}ms)`);

          resolve({
            success,
            output: outputBuffer.trim() || (success ? "(completed with no output)" : `Command exited with code ${exitCode}`),
            exitCode,
            operationId,
          });
        }
      });

      child.on("error", (err) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timeoutTimer);
          this.activeProcesses.delete(operationId);

          const durationMs = Date.now() - startTime;

          eventBus.publish(EVENT_TOPICS.AGENT_COMMAND_FAILED, {
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

          resolve({ success: false, output: err.message, exitCode: 1, operationId });
        }
      });
    });
  }

  /**
   * Stop an active background task by operationId, killing its entire process tree.
   * 
   * @param {string} operationId
   * @returns {Promise<boolean>}
   */
  async stopProcess(operationId) {
    const proc = this.activeProcesses.get(operationId);
    if (proc) {
      await killProcessTree(proc.pid);
      this.activeProcesses.delete(operationId);
      logger.info(`ProcessSupervisor: Terminated process tree for [${operationId}] (PID: ${proc.pid})`);
      return true;
    }
    return false;
  }

  /**
   * List all currently active background processes.
   */
  listActiveProcesses() {
    return Array.from(this.activeProcesses.values()).map(({ child, ...rest }) => rest);
  }
}

export const processSupervisor = new ProcessSupervisor();
