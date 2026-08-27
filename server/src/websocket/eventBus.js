/**
 * Central Event Bus — Standardized Event-Driven Backbone
 * 
 * Provides publish/subscribe mechanisms across UI panels, PTY processes,
 * file system operations, and AI agent execution streams with standardized
 * event envelopes, correlation IDs, and formalized event topics.
 */

import { EventEmitter } from "events";
import { logger } from "../config/logger.js";

/**
 * Formalized Event Taxonomy Topics
 */
export const EVENT_TOPICS = {
  // Terminal
  TERMINAL_SESSION_CREATED: "terminal.session.created",
  TERMINAL_SESSION_STATE: "terminal.session.state",
  TERMINAL_INPUT: "terminal.input",
  TERMINAL_KEYSTROKE: "terminal.keystroke",
  TERMINAL_PASTE: "terminal.paste",
  TERMINAL_COMMAND_SUBMITTED: "terminal.command.submitted",
  TERMINAL_OUTPUT: "terminal.output",
  TERMINAL_RESIZE: "terminal.resize",
  TERMINAL_SIGNAL: "terminal.signal",
  TERMINAL_EXIT: "terminal.exit",

  // Agent
  AGENT_COMMAND_REQUESTED: "agent.command.requested",
  AGENT_COMMAND_STARTED: "agent.command.started",
  AGENT_COMMAND_OUTPUT: "agent.command.output",
  AGENT_COMMAND_COMPLETED: "agent.command.completed",
  AGENT_COMMAND_FAILED: "agent.command.failed",
  AGENT_STATUS: "agent.status",

  // Filesystem
  FILE_CREATED: "file.created",
  FILE_CHANGED: "file.changed",
  FILE_DELETED: "file.deleted",
  FILE_RENAMED: "file.renamed",

  // Preview
  PREVIEW_STARTED: "preview.started",
  PREVIEW_READY: "preview.ready",
  PREVIEW_OUTPUT: "preview.output",
  PREVIEW_FAILED: "preview.failed",
  PREVIEW_STOPPED: "preview.stopped",

  // Permissions
  PERMISSION_REQUESTED: "permission.requested",
  PERMISSION_RESOLVED: "permission.resolved",
};

/**
 * Creates a standardized event envelope.
 * 
 * @param {object} params
 * @param {string} params.type - Event topic (e.g. 'terminal.output', 'agent.command.started')
 * @param {string} [params.workspaceId='default'] - Workspace identifier
 * @param {string} [params.sessionId=null] - Active session identifier
 * @param {string} [params.turnId=null] - Agent turn correlation identifier
 * @param {string} [params.operationId=null] - Discrete operation correlation identifier
 * @param {string} [params.source='system'] - Source component ('pty', 'agent', 'fs', 'preview', 'ui', 'system')
 * @param {string} [params.actor='system'] - Actor performing action ('user', 'agent', 'system')
 * @param {object} [params.payload={}] - Event-specific data
 * @returns {object} Standardized event envelope
 */
export function createEventEnvelope({
  type,
  workspaceId = "default",
  sessionId = null,
  turnId = null,
  operationId = null,
  source = "system",
  actor = "system",
  payload = {},
}) {
  return {
    eventId: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    type,
    timestamp: Date.now(),
    workspaceId,
    sessionId,
    turnId,
    operationId,
    source,
    actor,
    payload,
  };
}

class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);
  }

  /**
   * Publish an event onto the bus.
   * Accepts either an existing envelope object or (type, payload, options).
   * 
   * @param {string | object} eventOrType
   * @param {object} [payload={}]
   * @param {object} [options={}]
   * @returns {object} The published event envelope
   */
  publish(eventOrType, payload = {}, options = {}) {
    let envelope;

    if (typeof eventOrType === "object" && eventOrType !== null && eventOrType.eventId && eventOrType.type) {
      envelope = eventOrType;
    } else {
      envelope = createEventEnvelope({
        type: eventOrType,
        workspaceId: options.workspaceId || "default",
        sessionId: options.sessionId || null,
        turnId: options.turnId || null,
        operationId: options.operationId || null,
        source: options.source || "system",
        actor: options.actor || "system",
        payload: payload || {},
      });
    }

    logger.debug(`[EventBus] ${envelope.type} (${envelope.eventId})`, {
      actor: envelope.actor,
      operationId: envelope.operationId,
      sessionId: envelope.sessionId,
    });

    this.emit(envelope.type, envelope);
    this.emit("*", envelope);

    return envelope;
  }

  /**
   * Subscribe to a specific event topic or '*' for all events.
   * 
   * @param {string} type
   * @param {Function} listener - (envelope) => void
   * @returns {Function} Unsubscribe function
   */
  subscribe(type, listener) {
    this.on(type, listener);
    return () => this.off(type, listener);
  }
}

export const eventBus = new EventBus();
