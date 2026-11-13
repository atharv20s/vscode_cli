#!/usr/bin/env node
/**
 * Manual two-phase acceptance test for remote tmux terminal recovery.
 *
 * Run from the API host with EXECUTION_WORKER_URL and WORKER_SHARED_SECRET
 * loaded from the API service environment. The script creates a disposable
 * workspace identity, writes a marker into tmux, pauses for an operator to
 * restart the execution-worker Node service, then reconnects with the same
 * terminal UUID and verifies the marker is replayed.
 *
 * This tests a Node worker-process restart while Docker and its container stay
 * alive. It does not test Docker daemon/VM restart recovery.
 */
import crypto from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createRequire } from "node:module";
const require = createRequire(new URL("../server/package.json", import.meta.url));
const WebSocket = require("ws");
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../server/src/config/env.js";
import { dockerWorkspaceRuntime } from "../server/src/services/dockerWorkspaceRuntime.js";

const workerUrl = new URL(process.env.WORKER_LOCAL_URL || "http://127.0.0.1:8081");
const secret = process.env.WORKER_SHARED_SECRET || "";
if (!["127.0.0.1", "::1", "localhost"].includes(workerUrl.hostname) ||
    !["http:", "https:"].includes(workerUrl.protocol) || secret.length < 32) {
  throw new Error("Run this on the execution-worker host with WORKER_SHARED_SECRET loaded and WORKER_LOCAL_URL pointing to loopback.");
}

const workspaceId = crypto.randomBytes(32).toString("hex");
const sessionId = crypto.randomUUID();
const marker = "ATH_TERMINAL_RECOVERY_" + crypto.randomUUID().replace(/-/g, "");
const workspaceRoot = path.join(config.workspaceRoot, "remote-users", workspaceId);

async function getWorkerHealth() {
  const response = await fetch(new URL("/healthz", workerUrl), { signal: AbortSignal.timeout(10000) });
  const health = await response.json().catch(() => ({}));
  if (!response.ok || health.role !== "execution-worker" || typeof health.instanceId !== "string") {
    throw new Error("Execution worker health check failed or returned an unexpected service identity.");
  }
  return health;
}

function createSocket() {
  const target = new URL(workerUrl);
  target.protocol = workerUrl.protocol === "https:" ? "wss:" : "ws:";
  target.pathname = "/v1/terminal";
  target.search = "";
  target.searchParams.set("workspaceId", workspaceId);
  target.searchParams.set("sessionId", sessionId);
  target.searchParams.set("cols", "100");
  target.searchParams.set("rows", "30");
  const requestPath = target.pathname + target.search;
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const signature = crypto.createHmac("sha256", secret)
    .update(timestamp).update(".").update(nonce).update(".")
    .update("GET").update(".").update(requestPath).update(".")
    .update(Buffer.alloc(0)).digest("hex");
  const socket = new WebSocket(target, {
    headers: {
      "x-worker-timestamp": timestamp,
      "x-worker-nonce": nonce,
      "x-worker-signature": signature,
    },
    handshakeTimeout: 15000,
    maxPayload: 128 * 1024,
  });
  const messages = [];
  socket.on("message", raw => {
    try { messages.push(JSON.parse(raw.toString("utf8"))); } catch {}
  });
  socket.on("error", error => messages.push({ type: "socket.error", payload: { message: error.message } }));
  return { socket, messages };
}

function waitFor(messages, socket, predicate, description, timeoutMs = 60000) {
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Timed out waiting for " + description + ".")), timeoutMs);
    const onMessage = raw => {
      let message;
      try { message = JSON.parse(raw.toString("utf8")); } catch { return; }
      if (message.type === "socket.error") {
        finish(new Error(message.payload?.message || "Remote terminal socket failed."));
      } else if (message.type === "terminal.state" && message.payload?.state === "error") {
        finish(new Error(message.payload.error || "Remote terminal returned an error."));
      } else if (predicate(message)) finish(null, message);
    };
    const onClose = (code, reason) => finish(new Error("Terminal closed (" + code + "): " + reason.toString()));
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve(value);
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
  });
}

async function connectAndWaitReady() {
  const connection = createSocket();
  const opened = new Promise((resolve, reject) => {
    connection.socket.once("open", resolve);
    connection.socket.once("error", reject);
  });
  await opened;
  await waitFor(connection.messages, connection.socket,
    message => message.type === "terminal.state" && message.payload?.state === "ready",
    "terminal ready state");
  return connection;
}

const prompt = createInterface({ input: stdin, output: stdout });
let first;
let second;
try {
  const workerBefore = await getWorkerHealth();
  console.log("Disposable workspace:", workspaceId);
  console.log("Terminal session UUID:", sessionId);
  console.log("Execution worker instance before restart:", workerBefore.instanceId, "(PID", workerBefore.pid + ")");
  first = await connectAndWaitReady();
  first.socket.send(JSON.stringify({
    type: "terminal.input",
    payload: { data: "printf '\\n" + marker + "\\n'\n" },
  }));
  await waitFor(first.messages, first.socket,
    message => message.type === "terminal.output" && String(message.payload?.text || "").includes(marker),
    "initial terminal marker");
  const detached = new Promise(resolve => first.socket.once("close", resolve));
  first.socket.close();
  await detached;
  console.log("Marker written and tmux session detached.");

  await prompt.question("Now restart the systemd unit that runs server/src/worker/executionWorker.js (not the repo-agent worker unless it runs this entrypoint). Use its actual unit name, wait for /healthz to return healthy, then press Enter here: ");
  const workerAfter = await getWorkerHealth();
  if (workerAfter.instanceId === workerBefore.instanceId) {
    throw new Error("Execution worker instance ID did not change; the Node execution-worker restart was not observed.");
  }

  second = await connectAndWaitReady();
  const replay = await waitFor(second.messages, second.socket,
    message => message.type === "terminal.output" && String(message.payload?.text || "").includes(marker),
    "marker replay after worker restart");
  second.socket.send(JSON.stringify({ type: "terminal.kill", payload: {} }));
  second.socket.close();
  console.log(JSON.stringify({
    success: true,
    test: "remote-terminal-node-worker-restart",
    markerReplayed: String(replay.payload.text).includes(marker),
    workerRestartVerified: workerAfter.instanceId !== workerBefore.instanceId,
    workerPidBefore: workerBefore.pid,
    workerPidAfter: workerAfter.pid,
    workspaceId,
    sessionId,
    limitation: "Docker container and Docker daemon must remain running; this does not restore processes after container/VM restart.",
  }, null, 2));
} finally {
  if (first?.socket.readyState === WebSocket.OPEN) first.socket.close();
  if (second?.socket.readyState === WebSocket.OPEN) second.socket.close();
  prompt.close();
  // This utility runs on the worker host, so it can clean up the exact random
  // disposable container and directory without adding a destructive HTTP API.
  await dockerWorkspaceRuntime.stop(workspaceId).catch(error => {
    console.error("Could not remove disposable terminal container:", error.message);
  });
  await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(error => {
    console.error("Could not remove disposable terminal workspace:", error.message);
  });
}
