/**
 * Terminal Context Service
 * 
 * Subscribes to terminal, agent, and preview events to maintain an enriched,
 * structured real-time context store (CWD, active process, ports, session state,
 * activity timestamps, recent output tail, and errors) to feed directly into
 * the AI agent's reasoning loop.
 */

import { eventBus, EVENT_TOPICS } from "../websocket/eventBus.js";
import { config } from "../config/env.js";

/** Max lines of terminal output preserved in the rolling context buffer */
const MAX_OUTPUT_BUFFER_LINES = 100;
const MAX_ERROR_BUFFER_LINES = 20;

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

/** Regex to detect ports in output */
const PORT_REGEX = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})|listening on (?:port )?(\d{2,5})|port (\d{2,5})/gi;

/** Regex to detect error signatures in output lines */
const ERROR_SIGNATURE_REGEX = /\b(error|failed|exception|traceback|cannot find|syntaxerror|typeerror|enoent|econnrefused)\b/i;

class TerminalContextService {
  constructor() {
    /** @type {Map<string, object>} */
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
        sessionId,
        shell: "powershell",
        cwd: config.workspaceRoot,
        state: "ready",
        lastCommand: null,
        lastCommandTime: null,
        exitCode: null,
        activeProcess: null,
        detectedPorts: new Set(),
        lastUserActivity: Date.now(),
        lastAgentActivity: null,
        outputBuffer: [],
        errorBuffer: [],
      });
    }
    return this.contexts.get(sessionId);
  }

  /**
   * Subscribe to relevant EventBus topics to build live context.
   */
  _setupEventListeners() {
    // 1. Session State Changes
    eventBus.subscribe(EVENT_TOPICS.TERMINAL_SESSION_STATE, (envelope) => {
      const { sessionId, payload } = envelope;
      if (!sessionId) return;

      const ctx = this._ensureContext(sessionId);
      if (payload.state) ctx.state = payload.state;
      if (payload.shell) ctx.shell = payload.shell;
      if (payload.cwd) ctx.cwd = payload.cwd;
    });

    // 2. User Keystrokes & Inputs
    eventBus.subscribe(EVENT_TOPICS.TERMINAL_INPUT, (envelope) => {
      const { sessionId } = envelope;
      if (!sessionId) return;
      const ctx = this._ensureContext(sessionId);
      ctx.lastUserActivity = Date.now();
    });

    // 3. User Submitted Commands (Enter pressed)
    eventBus.subscribe(EVENT_TOPICS.TERMINAL_COMMAND_SUBMITTED, (envelope) => {
      const { sessionId, payload } = envelope;
      if (!sessionId) return;

      const ctx = this._ensureContext(sessionId);
      ctx.lastCommand = payload.command || "";
      ctx.lastCommandTime = envelope.timestamp || Date.now();
      ctx.lastUserActivity = Date.now();
      ctx.state = "running";

      if (payload.cwd) {
        ctx.cwd = payload.cwd;
      }

      // Detect active process executable name from command
      const firstToken = (payload.command || "").trim().split(/\s+/)[0]?.toLowerCase();
      if (firstToken) {
        ctx.activeProcess = firstToken.replace(/\.exe$/i, "");
      }
    });

    // 4. Streamed Terminal Output Chunks
    eventBus.subscribe(EVENT_TOPICS.TERMINAL_OUTPUT, (envelope) => {
      const { sessionId, payload } = envelope;
      if (!sessionId || !payload?.data) return;

      const ctx = this._ensureContext(sessionId);
      const cleanText = stripAnsi(payload.data);

      if (cleanText) {
        // Port detection
        let portMatch;
        while ((portMatch = PORT_REGEX.exec(cleanText)) !== null) {
          const port = parseInt(portMatch[1] || portMatch[2] || portMatch[3], 10);
          if (port && port > 0 && port < 65536) {
            ctx.detectedPorts.add(port);
          }
        }

        // Line splitting & buffer update
        const lines = cleanText.split(/\r?\n/).filter((l) => l.trim().length > 0);
        for (const line of lines) {
          ctx.outputBuffer.push(line);
          if (ctx.outputBuffer.length > MAX_OUTPUT_BUFFER_LINES) {
            ctx.outputBuffer.shift();
          }

          // Error line capture
          if (ERROR_SIGNATURE_REGEX.test(line)) {
            ctx.errorBuffer.push(line);
            if (ctx.errorBuffer.length > MAX_ERROR_BUFFER_LINES) {
              ctx.errorBuffer.shift();
            }
          }
        }
      }
    });

    // 5. Terminal Session Exit
    eventBus.subscribe(EVENT_TOPICS.TERMINAL_EXIT, (envelope) => {
      const { sessionId, payload } = envelope;
      if (!sessionId) return;

      const ctx = this._ensureContext(sessionId);
      ctx.state = "exited";
      ctx.exitCode = payload?.code ?? null;
      ctx.activeProcess = null;
    });

    // 6. Agent Background Command Lifecycle
    eventBus.subscribe(EVENT_TOPICS.AGENT_COMMAND_STARTED, (envelope) => {
      const { sessionId } = envelope;
      if (sessionId) {
        const ctx = this._ensureContext(sessionId);
        ctx.lastAgentActivity = Date.now();
      }
    });

    eventBus.subscribe(EVENT_TOPICS.AGENT_COMMAND_COMPLETED, (envelope) => {
      const { sessionId, payload } = envelope;
      if (sessionId) {
        const ctx = this._ensureContext(sessionId);
        ctx.lastAgentActivity = Date.now();
        if (payload?.output) {
          const clean = stripAnsi(payload.output);
          let portMatch;
          while ((portMatch = PORT_REGEX.exec(clean)) !== null) {
            const port = parseInt(portMatch[1] || portMatch[2] || portMatch[3], 10);
            if (port) ctx.detectedPorts.add(port);
          }
        }
      }
    });

    // 7. Preview Service Port Discoveries
    eventBus.subscribe(EVENT_TOPICS.PREVIEW_READY, (envelope) => {
      const { payload } = envelope;
      if (payload?.port) {
        for (const ctx of this.contexts.values()) {
          ctx.detectedPorts.add(payload.port);
        }
      }
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
      const all = Array.from(this.contexts.values());
      ctx = all[all.length - 1] || {
        sessionId: "default",
        shell: "powershell",
        cwd: config.workspaceRoot,
        state: "ready",
        lastCommand: null,
        lastCommandTime: null,
        exitCode: null,
        activeProcess: null,
        detectedPorts: new Set(),
        lastUserActivity: Date.now(),
        lastAgentActivity: null,
        outputBuffer: [],
        errorBuffer: [],
      };
    }

    const formatTimeAgo = (ts) => (ts ? `${Math.round((Date.now() - ts) / 1000)}s ago` : "none");

    return {
      sessionId: ctx.sessionId,
      shell: ctx.shell,
      cwd: ctx.cwd,
      state: ctx.state,
      lastCommand: ctx.lastCommand,
      lastCommandTimeAgo: formatTimeAgo(ctx.lastCommandTime),
      exitCode: ctx.exitCode,
      activeProcess: ctx.activeProcess,
      detectedPorts: Array.from(ctx.detectedPorts),
      lastUserActivity: formatTimeAgo(ctx.lastUserActivity),
      lastAgentActivity: formatTimeAgo(ctx.lastAgentActivity),
      recentOutputTail: ctx.outputBuffer.slice(-25),
      recentErrors: ctx.errorBuffer.slice(-5),
    };
  }
}

export const terminalContextService = new TerminalContextService();
