import { performance } from "node:perf_hooks";
import { EventEmitter } from "node:events";

const arg = (name, fallback) => {
  const item = process.argv.find((value) => value.startsWith(`--${name}=`));
  const value = item ? Number(item.split("=")[1]) : fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid --${name}`);
  return value;
};
const count = arg("events", 100000);
const bus = new EventEmitter();
const samples = new Array(count);
let received = 0;
bus.on("task", (event) => {
  samples[event.id] = performance.now() - event.startedAt;
  received++;
});
const started = performance.now();
for (let id = 0; id < count; id++) {
  bus.emit("task", { id, startedAt: performance.now() });
}
const elapsedMs = performance.now() - started;
const sorted = samples.filter(Number.isFinite).sort((a, b) => a - b);
const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? null;
console.log(JSON.stringify({
  benchmark: "in-process-eventemitter",
  eventsRequested: count,
  eventsReceived: received,
  failures: count - received,
  elapsedMs: Number(elapsedMs.toFixed(3)),
  throughputPerSec: Number((received / (elapsedMs / 1000)).toFixed(2)),
  latencyMs: { p50: percentile(0.50), p95: percentile(0.95), p99: percentile(0.99) },
  processRssMb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2)),
  node: process.version,
}, null, 2));
if (received !== count) process.exitCode = 1;
