/**
 * Terminal Session Manager
 * 
 * Manages the lifecycle and state machine for active interactive terminal sessions.
 * Maintains session metadata, PID, state transitions, and delegates execution
 * to the underlying LocalBackend or future KubernetesBackend.
 */

import { logger } from "../config/logger.js";
import { config } from "../config/env.js";
import { eventBus } from "../websocket/eventBus.js";
import { LocalBackend } from "./backends/localBackend.js";

/**
 * Terminal Lifecycle States
 * @typedef {'disconnected' | 'connecting' | 'ready' | 'running' | 'waiting_for_input' | 'exited' | 'error'} TerminalState
 */

/**
 * @typedef {Object} TerminalSession
 * @property {string} sessionId
 * @property {string} workspaceId
 * @property {'local' | 'kubernetes'} backend
 * @property {string} cwd
 * @property {string} shell
 * @property {number} cols
 * @property {number} rows
 * @property {number|null} pid
 * @property {TerminalState} state
 * @property {number} createdAt
 * @property {number} lastActivityAt
 * @property {any} [backendInstance]
 */

class TerminalSessionManager {
  constructor() {
    /** @type {Map<string, TerminalSession>} */
    this.sessions = new Map();
  }

  /**
   * Create and spawn a new interactive terminal session.
   * 
   * @param {string} sessionId - Unique session ID
   * @param {object} options
   * @param {string} [options.shellType='powershell']
   * @param {number} [options.cols=80]
   * @param {number} [options.rows=24]
   * @param {string} [options.workspaceId='default']
   * @param {string} [options.cwd]
   * @param {import('ws').WebSocket} options.ws
   * @returns {Promise<TerminalSession>}
   */
  async createSession(sessionId, options = {}) {
    this.destroySession(sessionId);

    const cwd = options.cwd || config.workspaceRoot;
    const shell = options.shellType || "powershell";
    const cols = options.cols || 80;
    const rows = options.rows || 24;
    const workspaceId = options.workspaceId || "default";

    const session = {
      sessionId,
      workspaceId,
      backend: "local",
      cwd,
      shell,
      cols,
      rows,
      pid: null,
      state: "connecting",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };

    this.sessions.set(sessionId, session);
    this._emitStateChange(session, "connecting");

    try {
      const backend = new LocalBackend();
      session.backendInstance = backend;

      const ptyProcess = await backend.spawnShell({
        sessionId,
        workspaceId,
        shellType: shell,
        cols,
        rows,
        cwd,
        ws: options.ws,
        onExit: (code) => {
          this._handleSessionExit(sessionId, code);
        },
      });

      session.pid = ptyProcess?.pid || null;
      session.state = "ready";
      this._emitStateChange(session, "ready");

      logger.info(`TerminalSessionManager: Session ${sessionId} ready (PID: ${session.pid}, Shell: ${shell})`);
      return session;
    } catch (err) {
      session.state = "error";
      this._emitStateChange(session, "error", { error: err.message });
      logger.error(`TerminalSessionManager: Failed to create session ${sessionId}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Write raw data or keystrokes to the terminal session.
   * 
   * @param {string} sessionId
   * @param {string} data
   */
  write(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.backendInstance) {
      logger.warn(`TerminalSessionManager: Write failed - session not found: ${sessionId}`);
      return false;
    }

    session.lastActivityAt = Date.now();
    session.backendInstance.write(sessionId, data);
    return true;
  }

  /**
   * Resize session terminal bounds.
   * 
   * @param {string} sessionId
   * @param {number} cols
   * @param {number} rows
   */
  resize(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    if (session && session.backendInstance) {
      session.cols = cols || session.cols;
      session.rows = rows || session.rows;
      session.backendInstance.resize(sessionId, session.cols, session.rows);
      logger.debug(`TerminalSessionManager: Resized session ${sessionId} to ${cols}x${rows}`);
    }
  }

  /**
   * Destroy and clean up an active terminal session.
   * 
   * @param {string} sessionId
   */
  destroySession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.backendInstance) {
        try {
          session.backendInstance.kill(sessionId);
        } catch {}
      }
      session.state = "disconnected";
      this._emitStateChange(session, "disconnected");
      this.sessions.delete(sessionId);
      logger.info(`TerminalSessionManager: Destroyed session ${sessionId}`);
    }
  }

  /**
   * Get an active session by ID.
   * 
   * @param {string} sessionId
   * @returns {TerminalSession | undefined}
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  /**
   * List all current sessions.
   * 
   * @returns {Array<Omit<TerminalSession, 'backendInstance'>>}
   */
  listSessions() {
    return Array.from(this.sessions.values()).map(({ backendInstance, ...rest }) => rest);
  }

  /**
   * @private
   */
  _handleSessionExit(sessionId, code) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = "exited";
      this._emitStateChange(session, "exited", { code });
      this.sessions.delete(sessionId);
    }
  }

  /**
   * @private
   */
  _emitStateChange(session, state, extra = {}) {
    eventBus.publish("terminal.state", {
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      state,
      shell: session.shell,
      cwd: session.cwd,
      pid: session.pid,
      ...extra,
    }, {
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      source: "pty",
      actor: "system",
    });
  }
}

export const terminalSessionManager = new TerminalSessionManager();
