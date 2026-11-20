-- Migration 002: Durable Kafka event outbox
-- Use enqueueEventInTransaction with the same PostgreSQL client as related
-- aggregate mutations whenever state changes and event creation must be atomic.

CREATE TABLE IF NOT EXISTS kafka_outbox (
  event_id VARCHAR(128) PRIMARY KEY,
  topic VARCHAR(255) NOT NULL,
  partition_key VARCHAR(256) NOT NULL,
  payload JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_until TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_kafka_outbox_pending
  ON kafka_outbox (next_attempt_at, created_at)
  WHERE published_at IS NULL;
