# ATH IDE reproducible benchmarks

These scripts make the performance claims measurable. They do **not** assert that
the previously quoted numbers have already been achieved. Run them on a recorded,
otherwise-idle machine and retain the emitted JSON with the commit SHA and
environment details.

## Install

```bash
cd server
npm ci
cd ..
```

## Event bus microbenchmark

```bash
node benchmarks/event-bus.mjs --events=100000
```

This measures the in-process EventEmitter-backed event bus only. It is not a
Kafka end-to-end latency benchmark and does not include network, broker,
consumer, database, or agent execution latency.

## WebSocket concurrency / reconnect benchmark

Start ATH IDE with a reachable WebSocket endpoint (for local unauthenticated
development, use the project's development configuration):

```bash
cd server && npm start
```

In another terminal:

```bash
node benchmarks/websocket-load.mjs --url=ws://127.0.0.1:3001/ws --connections=1000 --rounds=3
```

The script measures successful connections, ping/pong round-trip latency,
connection failures, reconnect time, process RSS where available, and message
throughput. Ping/pong RTT is **not** broadcast fan-out latency. A 1,500-connection
result is only valid if the run actually establishes all 1,500 connections.

## Redis node-expiry fault injection

Start a disposable Redis instance, then run:

```bash
REDIS_URL=redis://127.0.0.1:6379 \
REDIS_HEARTBEAT_MS=200 REDIS_NODE_TTL_MS=750 \
node benchmarks/redis-lease-fault.mjs
```

This measures Redis lease expiry after a simulated heartbeat-process crash. It
does not execute or reassign queued jobs. Therefore it cannot substantiate
"worker failover", "zero lost/duplicated jobs", or exactly-once processing.
Those require a durable job ledger, idempotency keys, worker ownership leases,
recovery/replay logic, and end-to-end fault-injection tests. The benchmark uses
a disposable Redis key prefix and deletes its test key.

## Reporting

Every script prints JSON including the observed values and benchmark settings.
Do not copy target figures into a resume unless the output from a repeatable run
actually supports them. Record CPU, RAM, OS, Node version, Redis/Kafka versions,
container limits, commit SHA, and the exact command alongside each result.
