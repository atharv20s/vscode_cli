/**
 * Central Event Bus — Standardized Event-Driven Backbone
 * 
 * Provides publish/subscribe mechanisms across UI panels, PTY processes,
 * file system operations, and AI agent execution streams with standardized
 * event envelopes and correlation IDs.
 */

import { EventEmitter } from "events";
import { logger } from "../config/logger.js";

/**
 * Creates a standardized event envelope.
 * 
 * @param {object} params
 * @param {string} params.type - Event topic (e.g. 'terminal.output', 'agent.command.started')
 * @param {string} [params.workspaceId='default'] - Workspace identifier
 * @param {string} [params.sessionId=null] - Active session identifier
 * @param {string} [params.turnId=null] - Agent turn correlation identifier
 * @param {string} [params.operationId=null] - Discrete operation correlation identifier
 * @param {string} [params.source='system'] - Source component ('pty', 'agent', 'fs', 'ui', 'system')
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
    this.setMaxListeners(150);
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
