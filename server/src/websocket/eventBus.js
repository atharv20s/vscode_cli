/**
 * Central Event Bus — local events with optional Redis Pub/Sub fan-out.
 *
 * Events are emitted locally immediately. When REDIS_URL is configured, the
 * same envelope is also published for other API replicas. Redis messages are
 * validated and de-duplicated before being exposed to local subscribers.
 *
 * Redis Pub/Sub is deliberately an ephemeral notification transport: durable
 * workspace file state must still live in a shared persistent storage backend.
 */

import { EventEmitter } from "events";
import Redis from "ioredis";
import { logger } from "../config/logger.js";

export const REDIS_EVENT_CHANNEL = "ath:workspace-events:v1";
const MAX_EVENT_BYTES = 512 * 1024;
const MAX_SEEN_EVENTS = 10000;
const SEEN_EVENT_TTL_MS = 120000;

/**
 * Formalized Event Taxonomy Topics.
 */
export const EVENT_TOPICS = {
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
  AGENT_COMMAND_REQUESTED: "agent.command.requested",
  AGENT_COMMAND_STARTED: "agent.command.started",
  AGENT_COMMAND_OUTPUT: "agent.command.output",
  AGENT_COMMAND_COMPLETED: "agent.command.completed",
  AGENT_COMMAND_FAILED: "agent.command.failed",
  AGENT_STATUS: "agent.status",
  FILE_CREATED: "file.created",
  FILE_CHANGED: "file.changed",
  FILE_DELETED: "file.deleted",
  FILE_RENAMED: "file.renamed",
  PREVIEW_STARTED: "preview.started",
  PREVIEW_READY: "preview.ready",
  PREVIEW_OUTPUT: "preview.output",
  PREVIEW_FAILED: "preview.failed",
  PREVIEW_STOPPED: "preview.stopped",
  PERMISSION_REQUESTED: "permission.requested",
  PERMISSION_RESOLVED: "permission.resolved",
};

/**
 * Creates a standardized event envelope.
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
    eventId: "evt_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7),
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

function isValidEnvelope(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.eventId === "string" &&
    value.eventId.length > 0 &&
    value.eventId.length <= 128 &&
    typeof value.type === "string" &&
    value.type.length > 0 &&
    value.type.length <= 128 &&
    typeof value.workspaceId === "string" &&
    value.workspaceId.length > 0 &&
    value.workspaceId.length <= 256 &&
    Number.isFinite(value.timestamp) &&
    value.payload &&
    typeof value.payload === "object" &&
    !Array.isArray(value.payload)
  );
}

export class EventBus extends EventEmitter {
  constructor({ RedisClass = Redis } = {}) {
    super();
    this.setMaxListeners(200);
    this.RedisClass = RedisClass;
    this.redisPublisher = null;
    this.redisSubscriber = null;
    this.seenEventIds = new Map();
  }

  /**
   * Connect the optional Redis transport. In required mode, missing or
   * unavailable Redis is a startup error instead of silently degrading to
   * process-local events.
   */
  async initialize({ redisUrl = "", required = false } = {}) {
    if (this.redisPublisher && this.redisSubscriber) return true;
    if (!redisUrl) {
      if (required) throw new Error("REDIS_URL is required when REQUIRE_DISTRIBUTED_EVENTS=true.");
      return false;
    }

    const redisOptions = {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (attempt) => Math.min(attempt * 1000, 10000),
    };
    const publisher = new this.RedisClass(redisUrl, redisOptions);
    const subscriber = publisher.duplicate();

    publisher.on("error", (error) => {
      logger.warn("Workspace event Redis publisher error", { error: error.message });
    });
    subscriber.on("error", (error) => {
      logger.warn("Workspace event Redis subscriber error", { error: error.message });
    });
    subscriber.on("message", (channel, rawMessage) => {
      if (channel !== REDIS_EVENT_CHANNEL) return;
      this._acceptRemoteMessage(rawMessage);
    });

    try {
      await publisher.connect();
      await subscriber.connect();
      await subscriber.subscribe(REDIS_EVENT_CHANNEL);
      this.redisPublisher = publisher;
      this.redisSubscriber = subscriber;
      logger.info("Redis-backed cross-instance workspace events enabled");
      return true;
    } catch (error) {
      await Promise.allSettled([
        publisher.quit?.(),
        subscriber.quit?.(),
      ]);
      logger.error("Could not initialize the distributed workspace event bus", {
        error: error.message,
      });
      throw error;
    }
  }

  _rememberEvent(eventId) {
    const now = Date.now();
    for (const [id, at] of this.seenEventIds) {
      if (now - at > SEEN_EVENT_TTL_MS) this.seenEventIds.delete(id);
      else break;
    }
    this.seenEventIds.set(eventId, now);
    while (this.seenEventIds.size > MAX_SEEN_EVENTS) {
      const oldest = this.seenEventIds.keys().next().value;
      this.seenEventIds.delete(oldest);
    }
  }

  _emitLocal(envelope) {
    if (!isValidEnvelope(envelope) || this.seenEventIds.has(envelope.eventId)) return false;
    this._rememberEvent(envelope.eventId);
    this.emit(envelope.type, envelope);
    this.emit("*", envelope);
    return true;
  }

  _acceptRemoteMessage(rawMessage) {
    if (typeof rawMessage !== "string" || Buffer.byteLength(rawMessage, "utf8") > MAX_EVENT_BYTES) {
      logger.warn("Ignoring oversized or invalid Redis workspace event.");
      return false;
    }
    try {
      const envelope = JSON.parse(rawMessage);
      if (!isValidEnvelope(envelope)) return false;
      return this._emitLocal(envelope);
    } catch {
      logger.warn("Ignoring malformed Redis workspace event.");
      return false;
    }
  }

  /**
   * Publish locally immediately and fan out to other replicas when Redis is
   * connected. A Redis echo is suppressed by eventId de-duplication.
   */
  publish(eventOrType, payload = {}, options = {}) {
    const envelope =
      typeof eventOrType === "object" && eventOrType !== null && eventOrType.eventId && eventOrType.type
        ? eventOrType
        : createEventEnvelope({
            type: eventOrType,
            workspaceId: options.workspaceId || "default",
            sessionId: options.sessionId || null,
            turnId: options.turnId || null,
            operationId: options.operationId || null,
            source: options.source || "system",
            actor: options.actor || "system",
            payload: payload || {},
          });

    this._emitLocal(envelope);

    if (this.redisPublisher?.status === "ready") {
      try {
        const serialized = JSON.stringify(envelope);
        if (Buffer.byteLength(serialized, "utf8") <= MAX_EVENT_BYTES) {
          this.redisPublisher.publish(REDIS_EVENT_CHANNEL, serialized).catch((error) => {
            logger.warn("Could not fan out workspace event through Redis", { error: error.message });
          });
        } else {
          logger.warn("Workspace event exceeded Redis fan-out size limit", { type: envelope.type });
        }
      } catch (error) {
        logger.warn("Could not serialize workspace event for Redis", { error: error.message });
      }
    }

    logger.debug("[EventBus] " + envelope.type + " (" + envelope.eventId + ")", {
      actor: envelope.actor,
      operationId: envelope.operationId,
      sessionId: envelope.sessionId,
    });
    return envelope;
  }

  /**
   * Subscribe to a specific event topic or "*" for all events.
   */
  subscribe(type, listener) {
    this.on(type, listener);
    return () => this.off(type, listener);
  }

  async shutdown() {
    const clients = [this.redisPublisher, this.redisSubscriber].filter(Boolean);
    this.redisPublisher = null;
    this.redisSubscriber = null;
    await Promise.allSettled(clients.map((client) => client.quit()));
    this.seenEventIds.clear();
  }

  getDistributedStatus() {
    return {
      enabled: Boolean(this.redisPublisher && this.redisSubscriber),
      publisher: this.redisPublisher?.status || "disabled",
      subscriber: this.redisSubscriber?.status || "disabled",
      channel: REDIS_EVENT_CHANNEL,
    };
  }
}

export const eventBus = new EventBus();
