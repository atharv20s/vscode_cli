/**
 * Terminal Context Service
 * 
 * Subscribes to terminal events and maintains structured, high-value context
 * (CWD, last submitted command, exit codes, recent output tail) to inject into
 * the AI agent's reasoning loop, avoiding raw character firehoses.
 */

import { eventBus } from "../websocket/eventBus.js";
import { config } from "../config/env.js";

/** Max lines of terminal output preserved in the rolling context buffer */
const MAX_OUTPUT_BUFFER_LINES = 100;

/**
 * Strip ANSI escape codes from terminal output.
 * @param {string} str
 * @returns {string}
 */
function stripAnsi(str) {
  if (!str || typeof str !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
}

class TerminalContextService {
  constructor() {
    /** @type {Map<string, { cwd: string, lastCommand: string|null, lastCommandTime: number|null, exitCode: number|null, outputBuffer: string[] }>} */
    this.contexts = new Map();

    this._setupEventListeners();
  }

  /**
   * Initialize or retrieve context state for a session.
   * @param {string} sessionId
   */
  _ensureContext(sessionId) {
    if (!this.contexts.has(sessionId)) {
      this.contexts.set(sessionId, {
        cwd: config.workspaceRoot,
        lastCommand: null,
        lastCommandTime: null,
        exitCode: null,
        outputBuffer: [],
      });
    }
    return this.contexts.get(sessionId);
  }

  /**
   * Subscribe to relevant EventBus topics to build live context.
   */
  _setupEventListeners() {
    // 1. Listen for submitted commands (Enter pressed)
    eventBus.subscribe("terminal.command.submitted", (envelope) => {
      const { sessionId, payload } = envelope;
      if (!sessionId) return;

      const ctx = this._ensureContext(sessionId);
      ctx.lastCommand = payload.command || "";
      ctx.lastCommandTime = envelope.timestamp || Date.now();
      if (payload.cwd) {
        ctx.cwd = payload.cwd;
      }
    });

    // 2. Listen for streamed terminal output chunks
    eventBus.subscribe("terminal.output", (envelope) => {
      const { sessionId, payload } = envelope;
      if (!sessionId || !payload?.data) return;

      const ctx = this._ensureContext(sessionId);
      const cleanText = stripAnsi(payload.data);

      if (cleanText) {
        const lines = cleanText.split(/\r?\n/).filter(l => l.trim().length > 0);
        for (const line of lines) {
          ctx.outputBuffer.push(line);
          if (ctx.outputBuffer.length > MAX_OUTPUT_BUFFER_LINES) {
            ctx.outputBuffer.shift();
          }
        }
      }
    });

    // 3. Listen for terminal session exit
    eventBus.subscribe("terminal.exit", (envelope) => {
      const { sessionId, payload } = envelope;
      if (!sessionId) return;

      const ctx = this._ensureContext(sessionId);
      ctx.exitCode = payload?.code ?? null;
    });
  }

  /**
   * Retrieve structured context formatted for LLM consumption.
   * 
   * @param {string} [sessionId]
   * @returns {object} Structured context summary
   */
  getStructuredContext(sessionId) {
    let ctx = null;

    if (sessionId && this.contexts.has(sessionId)) {
      ctx = this.contexts.get(sessionId);
    } else {
      // Fallback: use the most recently updated context or default
      const all = Array.from(this.contexts.values());
      ctx = all[all.length - 1] || {
        cwd: config.workspaceRoot,
        lastCommand: null,
        lastCommandTime: null,
        exitCode: null,
        outputBuffer: [],
      };
    }

    const timeAgo = ctx.lastCommandTime
      ? `${Math.round((Date.now() - ctx.lastCommandTime) / 1000)}s ago`
      : "none";

    return {
      cwd: ctx.cwd,
      last_command: ctx.lastCommand,
      last_command_timestamp: timeAgo,
      exit_code: ctx.exitCode,
      recent_terminal_output_tail: ctx.outputBuffer.slice(-25),
    };
  }
}

export const terminalContextService = new TerminalContextService();
