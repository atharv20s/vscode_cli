/**
 * Process Supervisor
 * 
 * Manages, tracks, and supervises all background agent execution processes.
 * Enforces execution timeouts, assigns correlation IDs, handles cross-platform
 * process tree termination to prevent orphaned processes from holding ports,
 * and publishes formalized agent.command.* lifecycle events.
 */

import { spawn, exec } from "child_process";
import path from "node:path";
import { logger } from "../config/logger.js";
import { config } from "../config/env.js";
import { eventBus, EVENT_TOPICS } from "../websocket/eventBus.js";
import { buildStrictSSHOptions, resolveRemoteWorkspacePath, shellQuote, validateDockerContainer, validateSSHHost, validateSSHUsername } from "./sshSecurity.js";
import { BoundedOutputCapture } from "./boundedOutputCapture.js";
import { sanitizeChildEnv } from "./secretSanitizer.js";

export function syncRemoteSandboxDir(direction, localDir, remoteDir, rs) {
  return new Promise((resolve) => {
    if (!localDir || !remoteDir || !rs?.host) return resolve();
    try {
      const isWindows = process.platform === "win32";
      const sshBin = isWindows ? "ssh.exe" : "ssh";
      const tarBin = isWindows ? "tar.exe" : "tar";
      const sshArgs = buildStrictSSHOptions({ port: rs.port || 22, connectTimeout: 10 });
      if (rs.keyPath) sshArgs.push("-i", rs.keyPath);
      const remoteUser = validateSSHUsername(rs.user || "ubuntu");
      validateSSHHost(rs.host);
      const target = remoteUser + "@" + rs.host;

      if (direction === "push") {
        const remoteCmd = `mkdir -p ${shellQuote(remoteDir)} && tar -xf - -C ${shellQuote(remoteDir)}`;
        const tarProc = spawn(tarBin, ["-cf", "-", "--exclude=node_modules", "--exclude=.git", "-C", localDir, "."], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
        const sshProc = spawn(sshBin, [...sshArgs, target, remoteCmd], { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
        tarProc.stdout.pipe(sshProc.stdin);
        const timer = setTimeout(() => { try { tarProc.kill(); sshProc.kill(); } catch {} resolve(); }, 15000);
        sshProc.on("close", () => { clearTimeout(timer); resolve(); });
        sshProc.on("error", () => { clearTimeout(timer); resolve(); });
        tarProc.on("error", () => { clearTimeout(timer); try { sshProc.kill(); } catch {} resolve(); });
      } else {
        const remoteCmd = `mkdir -p ${shellQuote(remoteDir)} && tar -cf - --exclude=node_modules --exclude=.git -C ${shellQuote(remoteDir)} .`;
        const sshProc = spawn(sshBin, [...sshArgs, target, remoteCmd], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
        const tarProc = spawn(tarBin, ["-xf", "-", "-C", localDir], { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
        sshProc.stdout.pipe(tarProc.stdin);
        const timer = setTimeout(() => { try { sshProc.kill(); tarProc.kill(); } catch {} resolve(); }, 15000);
        tarProc.on("close", () => { clearTimeout(timer); resolve(); });
        tarProc.on("error", () => { clearTimeout(timer); try { sshProc.kill(); } catch {} resolve(); });
        sshProc.on("error", () => { clearTimeout(timer); try { tarProc.kill(); } catch {} resolve(); });
      }
    } catch {
      resolve();
    }
  });
}

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
    // Defense in depth: never execute arbitrary commands in the shared API
    // container. Production execution must use a dedicated isolated runner.
    if (!config.isDev) {
      throw new Error("Isolated execution runtime is not configured. Command execution is temporarily unavailable.");
    }

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
    let remoteSyncContext = null;

    // Check if remote Oracle Cloud (OCI) sandbox execution is enabled
    if (config.remoteSandbox?.enabled && config.remoteSandbox?.host) {
      const rs = config.remoteSandbox;
      const remoteBase = rs.workspace || "/home/ubuntu/agent-workspace";
      validateSSHHost(rs.host);
      const remoteUser = validateSSHUsername(rs.user || "ubuntu");
      const relativeWorkspacePath = cwd && cwd !== config.workspaceRoot ? path.relative(config.workspaceRoot, cwd).replaceAll("\\", "/") : ".";
      if (relativeWorkspacePath.startsWith("../") || relativeWorkspacePath === ".." || path.isAbsolute(relativeWorkspacePath)) throw new Error("Requested working directory is outside the configured workspace.");
      const remoteCwd = resolveRemoteWorkspacePath(remoteBase, relativeWorkspacePath);
      if (cwd && cwd !== config.workspaceRoot && relativeWorkspacePath !== ".") {
        remoteSyncContext = { localDir: cwd, remoteDir: remoteCwd, rs };
      }
      const remoteCommand = "mkdir -p " + shellQuote(remoteCwd) + " && cd " + shellQuote(remoteCwd) + " && " + command;
      let remotePayload;
      if (rs.dockerContainer) {
        const container = validateDockerContainer(rs.dockerContainer);
        remotePayload = "docker exec -i " + container + " bash -lc " + shellQuote(remoteCommand);
      } else {
        remotePayload = "bash -lc " + shellQuote(remoteCommand);
      }

      shellExecutable = isWindows ? "ssh.exe" : "ssh";
      shellArgs = buildStrictSSHOptions({ port: rs.port || 22, connectTimeout: 10 });
      if (rs.keyPath) shellArgs.push("-i", rs.keyPath);
      shellArgs.push(remoteUser + "@" + rs.host, remotePayload);
      logger.info(`ProcessSupervisor: Routing [${operationId}] to Oracle Cloud Sandbox (${rs.host}): ${command}`);
    } else if (isWindows) {
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

    if (remoteSyncContext) {
      await syncRemoteSandboxDir("push", remoteSyncContext.localDir, remoteSyncContext.remoteDir, remoteSyncContext.rs);
    }

    return new Promise((resolve) => {
      const outputCapture = new BoundedOutputCapture();
      let isSettled = false;

      let child;
      try {
        const sanitizedChildEnv = sanitizeChildEnv({ ...process.env, TERM: "dumb" });

        child = spawn(shellExecutable, shellArgs, {
          cwd,
          env: sanitizedChildEnv,
          windowsHide: true,
        });
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const captured = outputCapture.snapshot();
        eventBus.publish(EVENT_TOPICS.AGENT_COMMAND_FAILED, {
          command,
          exitCode: 1,
          durationMs,
          ...captured,
          error: err.message,
        }, {
          workspaceId,
          sessionId,
          turnId,
          operationId,
          source: "agent",
          actor: "agent",
        });

        return resolve({
          success: false,
          ...captured,
          output: [captured.output, err.message].filter(Boolean).join("\n"),
          exitCode: 1,
          signal: null,
          durationMs,
          operationId,
        });
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
          const captured = outputCapture.snapshot();

          eventBus.publish(EVENT_TOPICS.AGENT_COMMAND_FAILED, {
            command,
            exitCode: -1,
            durationMs,
            signal: "SIGKILL",
            ...captured,
            error: msg,
          }, {
            workspaceId,
            sessionId,
            turnId,
            operationId,
            source: "agent",
            actor: "agent",
          });

          resolve({ success: false, ...captured, output: captured.output.trim(), exitCode: -1, signal: "SIGKILL", durationMs, operationId });
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

            const durationMs = Date.now() - startTime;
            const captured = outputCapture.snapshot();
            resolve({ success: false, ...captured, output: captured.output.trim(), exitCode: -1, signal: "SIGKILL", durationMs, operationId });
          }
        });
      }

      // Stream stdout chunks
      child.stdout.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        outputCapture.append("stdout", chunk);

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
        outputCapture.append("stderr", chunk);

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

      child.on("close", async (code, signal) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timeoutTimer);
          this.activeProcesses.delete(operationId);
          if (remoteSyncContext) {
            await syncRemoteSandboxDir("pull", remoteSyncContext.localDir, remoteSyncContext.remoteDir, remoteSyncContext.rs);
          }

          const durationMs = Date.now() - startTime;
          const captured = outputCapture.snapshot();
          const exitCode = Number.isInteger(code) ? code : -1;
          const success = exitCode === 0 && !signal;

          if (success) {
            eventBus.publish(EVENT_TOPICS.AGENT_COMMAND_COMPLETED, {
              command,
              exitCode,
              durationMs,
              ...captured,
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
              ...captured,
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
            ...captured,
            output: captured.output.trim() || (success ? "(completed with no output)" : `Command exited with code ${exitCode}`),
            exitCode,
            signal: signal || null,
            durationMs,
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

          const captured = outputCapture.snapshot();
          eventBus.publish(EVENT_TOPICS.AGENT_COMMAND_FAILED, {
            command,
            exitCode: 1,
            durationMs,
            ...captured,
            error: err.message,
          }, {
            workspaceId,
            sessionId,
            turnId,
            operationId,
            source: "agent",
            actor: "agent",
          });

          resolve({
            success: false,
            ...captured,
            output: [captured.output, err.message].filter(Boolean).join("\n"),
            exitCode: 1,
            signal: null,
            durationMs,
            operationId,
          });
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
