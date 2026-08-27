/**
 * Execution Service
 * 
 * Central controller abstracting command execution across distinct modes:
 * - USER_INTERACTIVE: User's primary xterm.js PTY shell (managed by TerminalSessionManager).
 * - AGENT_BACKGROUND: Dedicated, non-interactive process runner (managed by ProcessSupervisor).
 * - AGENT_INTERACTIVE: Dedicated interactive agent PTY shell.
 */

import { logger } from "../config/logger.js";
import { config } from "../config/env.js";
import { terminalSessionManager } from "./terminalSessionManager.js";
import { processSupervisor } from "./processSupervisor.js";

/**
 * @typedef {'USER_INTERACTIVE' | 'AGENT_BACKGROUND' | 'AGENT_INTERACTIVE'} ExecutionMode
 */

class ExecutionService {
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
   * @returns {Promise<{ success: boolean, output: string, exitCode: number, operationId: string }>}
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
      return { success: true, output: `Command sent to user interactive terminal.`, exitCode: 0, operationId };
    }

    // Mode 2: AGENT_BACKGROUND (Delegate to ProcessSupervisor)
    logger.debug(`ExecutionService: Delegating [${operationId}] to ProcessSupervisor: ${command}`);
    return processSupervisor.execute({
      command,
      cwd,
      shell,
      timeout,
      signal,
      operationId,
      turnId,
      sessionId,
      workspaceId,
    });
  }

  /**
   * Stop an active background task by operationId.
   */
  async stopBackgroundTask(operationId) {
    return processSupervisor.stopProcess(operationId);
  }

  /**
   * List all currently active background processes.
   */
  listActiveProcesses() {
    return processSupervisor.listActiveProcesses();
  }
}

export const executionService = new ExecutionService();
