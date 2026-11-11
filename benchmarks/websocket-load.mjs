import WebSocket from "ws";
import { performance } from "node:perf_hooks";

const option = (name, fallback) => {
  const item = process.argv.find((value) => value.startsWith(`--${name}=`));
  return item ? item.slice(name.length + 3) : fallback;
};
const url = option("url", "ws://127.0.0.1:3001/ws");
const connections = Number(option("connections", "1000"));
const rounds = Number(option("rounds", "3"));
const timeoutMs = Number(option("timeout-ms", "10000"));
if (![connections, rounds, timeoutMs].every((v) => Number.isSafeInteger(v) && v > 0)) {
  throw new Error("connections, rounds and timeout-ms must be positive integers");
}
const sockets = new Set();
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? Number(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)].toFixed(3)) : null;
};
const connectOne = () => new Promise((resolve) => {
  const ws = new WebSocket(url);
  let settled = false;
  const timer = setTimeout(() => finish(false, "connect timeout"), timeoutMs);
  const finish = (ok, error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (ok) sockets.add(ws);
    resolve({ ok, error, ws });
  };
  ws.once("open", () => finish(true));
  ws.once("error", (error) => finish(false, error.message));
});
const started = performance.now();
const results = await Promise.all(Array.from({ length: connections }, connectOne));
const connectMs = performance.now() - started;
const opened = results.filter((r) => r.ok).map((r) => r.ws);
const errors = results.filter((r) => !r.ok).map((r) => r.error);
const rtts = [];
let pongs = 0;
for (let round = 0; round < rounds; round++) {
  await Promise.all(opened.map((ws) => new Promise((resolve) => {
    if (ws.readyState !== WebSocket.OPEN) return resolve();
    const payload = String(Date.now()) + ":" + Math.random();
    const sentAt = performance.now();
    const timer = setTimeout(resolve, timeoutMs);
    const onMessage = (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type !== "pong") return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      rtts.push(performance.now() - sentAt);
      pongs++;
      resolve();
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ type: "ping", payload: { nonce: payload } }));
  })));
}
const dropAt = performance.now();
for (const ws of opened) ws.terminate();
const reconnectStart = performance.now();
const reconnects = await Promise.all(Array.from({ length: opened.length }, connectOne));
const reconnectMs = performance.now() - reconnectStart;
const reconnectSuccess = reconnects.filter((r) => r.ok).length;
for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.close();
console.log(JSON.stringify({
  benchmark: "websocket-connect-ping-reconnect",
  url,
  requestedConnections: connections,
  openedConnections: opened.length,
  connectionFailures: errors.length,
  connectionSetupMs: Number(connectMs.toFixed(3)),
  pingRounds: rounds,
  expectedPongs: opened.length * rounds,
  receivedPongs: pongs,
  pingRttMs: { p50: percentile(rtts, 0.50), p95: percentile(rtts, 0.95), p99: percentile(rtts, 0.99) },
  reconnectAttempted: opened.length,
  reconnectSucceeded: reconnectSuccess,
  reconnectFailures: reconnects.length - reconnectSuccess,
  reconnectPoolMs: Number(reconnectMs.toFixed(3)),
  processRssMb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2)),
  elapsedSinceDropMs: Number((performance.now() - dropAt).toFixed(3)),
  node: process.version,
}, null, 2));
if (opened.length !== connections || pongs !== opened.length * rounds || reconnectSuccess !== opened.length) process.exitCode = 1;
