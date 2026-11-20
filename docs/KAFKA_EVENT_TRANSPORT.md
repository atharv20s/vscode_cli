# Kafka event transport

ATH IDE uses Kafka for durable domain-event transport, PostgreSQL as the
authoritative application/job store, and Redis for leases, heartbeats,
cancellation signals and the existing Redis Streams work queue.

## Local development

Start a Kafka-compatible Redpanda broker:

    docker compose -f docker-compose.kafka.yml up -d

Set these variables in the server environment:

    KAFKA_BROKERS=localhost:9092
    KAFKA_CLIENT_ID=ath-ide
    KAFKA_EVENT_TOPIC=ath-ide.events
    KAFKA_REQUIRED=false

Run the PostgreSQL migration before enabling the outbox relay:

    cd server
    npm run db:migrate
    npm test

## Event flow

1. The in-process EventEmitter delivers events immediately to local services.
2. Redis Pub/Sub continues to fan out ephemeral workspace notifications.
3. Selected domain lifecycle events are persisted in kafka_outbox.
4. The outbox relay publishes those records to ath-ide.events with broker
   acknowledgements.
5. Each API replica uses its own Kafka consumer group so its local WebSocket
   clients receive the event. Event IDs deduplicate Redis/Kafka echoes.
6. Invalid Kafka envelopes are sent to ath-ide.events.dlq. Failed local
   delivery is allowed to fail the consumer callback so Kafka can retry.

## Delivery and correctness

The relay provides at-least-once delivery. A process can publish an event and
crash before marking the outbox row published, so consumers must be idempotent
by eventId. Producer idempotence reduces producer retry duplicates but does
not make downstream side effects exactly-once.

For a domain mutation that must be atomic with event creation, call
enqueueEventInTransaction(client, event) using the same PostgreSQL transaction
and client that writes the domain row. The generic EventBus integration
persists event records after local publication; it cannot retroactively make
an unrelated earlier database mutation atomic.

## Scope boundary

The existing repository-agent work queue remains Redis Streams with Redis
leases/fencing. The in-process executionQueue accepts JavaScript closures,
which are not serializable Kafka messages. Do not claim that Kafka currently
replaces either queue. A later migration of serializable task contracts to
Kafka requires a separate worker protocol and end-to-end idempotency tests.

Terminal keystrokes/output and other high-volume ephemeral events are
intentionally excluded from the durable outbox.
