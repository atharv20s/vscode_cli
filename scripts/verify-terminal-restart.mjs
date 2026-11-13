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
import WebSocket from "ws";

const workerUrl = process.env.EXECUTION_WORKER_URL || "";
const secret = process.env.WORKER_SHARED_SECRET || "";
if (!workerUrl.startsWith("https://") || secret.length < 32) {
  throw new Error("Load EXECUTION_WORKER_URL (HTTPS) and WORKER_SHARED_SECRET (32+ chars) from the API environment.");
}

const workspaceId = crypto.randomBytes(32).toString("hex");
const sessionId = crypto.randomUUID();
const marker = "ATH_TERMINAL_RECOVERY_" + crypto.randomUUID().replace(/-/g, "");

function createSocket() {
  const target = new URL(workerUrl);
  target.protocol = "wss:";
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
    try {
      const parsed = JSON.parse(raw.toString("utf8"));
      messages.push(parsed);
      console.log("[WS MSG]", JSON.stringify(parsed));
    } catch {}
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
  console.log("Disposable workspace:", workspaceId);
  console.log("Terminal session UUID:", sessionId);
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

  await prompt.question("Now restart the Node execution-worker service (for example: sudo systemctl restart ath-ide-worker.service), wait for it to return healthy, then press Enter here: ");

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
    workspaceId,
    sessionId,
    limitation: "Docker container and Docker daemon must remain running; this does not restore processes after container/VM restart.",
  }, null, 2));
} finally {
  if (first?.socket.readyState === WebSocket.OPEN) first.socket.close();
  if (second?.socket.readyState === WebSocket.OPEN) second.socket.close();
  prompt.close();
}
