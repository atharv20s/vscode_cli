/**
 * PostgreSQL outbox for durable ATH IDE domain events.
 * At-least-once relay: consumers must be idempotent by eventId.
 */
import { getPostgresPool } from "../db/postgres.js";
import { kafkaService } from "./kafkaService.js";
import { logger } from "../config/logger.js";

const BATCH_SIZE = Math.max(1, Math.min(500, Number(process.env.KAFKA_OUTBOX_BATCH_SIZE || 50)));
const POLL_INTERVAL_MS = Math.max(250, Number(process.env.KAFKA_OUTBOX_POLL_MS || 1000));
const MAX_EVENT_BYTES = 512 * 1024;

export const DURABLE_EVENT_TYPES = new Set([
  "agent.command.requested", "agent.command.started", "agent.command.completed",
  "agent.command.failed", "agent.status", "file.created", "file.changed",
  "file.deleted", "file.renamed", "preview.started", "preview.ready",
  "preview.failed", "preview.stopped", "permission.requested",
  "permission.resolved", "queue.job_enqueued", "queue.job_started",
  "queue.job_completed", "queue.job_failed",
]);

const SAFE_PAYLOAD_FIELDS = {
  "agent.command.requested": [],
  "agent.command.started": [],
  "agent.command.completed": ["exitCode", "durationMs", "signal"],
  "agent.command.failed": ["exitCode", "durationMs", "signal"],
  "agent.status": ["status", "state", "agentId"],
  "file.created": ["path", "operation", "version", "contentVersion", "size"],
  "file.changed": ["path", "operation", "version", "contentVersion", "size"],
  "file.deleted": ["path", "operation", "version"],
  "file.renamed": ["from", "to", "path", "operation", "version"],
  "preview.started": ["timestamp"],
  "preview.ready": ["port", "timestamp"],
  "preview.failed": ["status"],
  "preview.stopped": ["timestamp", "code"],
  "permission.requested": ["permissionId", "expiresAt"],
  "permission.resolved": ["permissionId", "granted"],
};

function serializeEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event) ||
      typeof event.eventId !== "string" || !event.eventId ||
      typeof event.type !== "string" || !event.type ||
      typeof event.workspaceId !== "string" || !event.workspaceId ||
      !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    throw new Error("Invalid event envelope for Kafka outbox.");
  }
  const fields = SAFE_PAYLOAD_FIELDS[event.type] || [];
  const payload = Object.fromEntries(fields
    .filter(key => Object.prototype.hasOwnProperty.call(event.payload, key))
    .map(key => [key, event.payload[key]]));
  // Do not persist command text, shell output, workspace paths, preview
  // capability URLs, permission descriptors, or arbitrary metadata.
  const safeEvent = {
    eventId: event.eventId,
    type: event.type,
    timestamp: event.timestamp,
    workspaceId: event.workspaceId,
    sessionId: event.sessionId || null,
    turnId: event.turnId || null,
    operationId: event.operationId || null,
    source: event.source || "system",
    actor: event.actor || "system",
    payload,
  };
  const serialized = JSON.stringify(safeEvent);
  if (Buffer.byteLength(serialized, "utf8") > MAX_EVENT_BYTES) throw new Error("Event exceeds the Kafka outbox size limit.");
  return serialized;
}

async function insertOutboxRecord(client, event) {
  const serialized = serializeEvent(event);
  await client.query(
    "INSERT INTO kafka_outbox (event_id, topic, partition_key, payload) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (event_id) DO NOTHING",
    [event.eventId, kafkaService.topic, String(event.workspaceId || event.sessionId || "global"), serialized]
  );
}

/** Call with the same PostgreSQL transaction client as the related aggregate mutation. */
export async function enqueueEventInTransaction(client, event) {
  if (!client || typeof client.query !== "function") throw new Error("A PostgreSQL transaction client is required.");
  return insertOutboxRecord(client, event);
}

class KafkaOutboxService {
  constructor() {
    this.timer = null;
    this.inFlight = null;
    this.stopped = true;
  }

  async enqueueEvent(event) {
    if (!DURABLE_EVENT_TYPES.has(event?.type)) return false;
    const pool = getPostgresPool();
    if (!pool) return false;
    await insertOutboxRecord(pool, event);
    if (!this.stopped) void this.flush();
    return true;
  }

  async start() {
    if (this.timer || !getPostgresPool() || !kafkaService.isConnected) return false;
    this.stopped = false;
    this.timer = setInterval(() => { void this.flush(); }, POLL_INTERVAL_MS);
    this.timer.unref?.();
    await this.flush();
    logger.info("Kafka PostgreSQL outbox relay started", { pollIntervalMs: POLL_INTERVAL_MS, batchSize: BATCH_SIZE });
    return true;
  }

  async flush() {
    if (this.stopped || !kafkaService.isConnected || !getPostgresPool()) return;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this._flushBatch();
    try { return await this.inFlight; }
    finally { this.inFlight = null; }
  }

  async _flushBatch() {
    const pool = getPostgresPool();
    if (!pool) return;
    const claim = await pool.query(
      "WITH candidates AS (" +
      " SELECT event_id FROM kafka_outbox" +
      " WHERE published_at IS NULL AND next_attempt_at <= CURRENT_TIMESTAMP" +
      " AND (locked_until IS NULL OR locked_until < CURRENT_TIMESTAMP)" +
      " ORDER BY created_at, event_id LIMIT $1 FOR UPDATE SKIP LOCKED" +
      ") UPDATE kafka_outbox AS outbox" +
      " SET locked_until = CURRENT_TIMESTAMP + INTERVAL '30 seconds', attempts = outbox.attempts + 1" +
      " FROM candidates WHERE outbox.event_id = candidates.event_id" +
      " RETURNING outbox.event_id, outbox.topic, outbox.partition_key, outbox.payload, outbox.attempts",
      [BATCH_SIZE]
    );

    for (const row of claim.rows) {
      try {
        const event = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
        await kafkaService.publishEvent(event, row.topic);
        await pool.query(
          "UPDATE kafka_outbox SET published_at = CURRENT_TIMESTAMP, locked_until = NULL, last_error = NULL WHERE event_id = $1",
          [row.event_id]
        );
      } catch (error) {
        const delaySeconds = Math.min(60, 2 ** Math.min(Number(row.attempts) || 1, 6));
        await pool.query(
          "UPDATE kafka_outbox SET locked_until = NULL, next_attempt_at = CURRENT_TIMESTAMP + ($2::int * INTERVAL '1 second'), last_error = LEFT($3, 2000) WHERE event_id = $1",
          [row.event_id, delaySeconds, error.message]
        ).catch(updateError => logger.error("Could not reschedule Kafka outbox event", { eventId: row.event_id, error: updateError.message }));
        logger.warn("Kafka outbox event delivery failed; scheduled retry", { eventId: row.event_id, attempts: row.attempts, error: error.message });
      }
    }
  }

  async getStatus() {
    const pool = getPostgresPool();
    if (!pool) return { enabled: false, reason: "PostgreSQL is not configured." };
    try {
      const result = await pool.query(
        "SELECT COUNT(*) FILTER (WHERE published_at IS NULL)::int AS pending, " +
        "COUNT(*) FILTER (WHERE published_at IS NOT NULL)::int AS published, " +
        "MIN(created_at) FILTER (WHERE published_at IS NULL) AS oldest_pending_at FROM kafka_outbox"
      );
      return { enabled: true, ...result.rows[0] };
    } catch (error) { return { enabled: false, error: error.message }; }
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.inFlight) await this.inFlight.catch(() => {});
  }
}

export const kafkaOutboxService = new KafkaOutboxService();
