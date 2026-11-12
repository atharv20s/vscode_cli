/**
 * API-side authenticated WebSocket tunnel to the persistent Linux worker PTY.
 */
import crypto from "crypto";
import WebSocket from "ws";
import { config } from "../config/env.js";
import { syncWorkspaceOnRemote, workspaceRuntimeKey } from "./remoteExecutionWorker.js";

function signedHeaders(requestPath) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const secret = config.workerSharedSecret;
  const signature = crypto.createHmac("sha256", secret)
    .update(timestamp).update(".").update(nonce).update(".")
    .update("GET").update(".").update(requestPath).update(".")
    .update(Buffer.alloc(0)).digest("hex");
  return {
    "x-worker-timestamp": timestamp,
    "x-worker-nonce": nonce,
    "x-worker-signature": signature,
  };
}

export async function connectRemoteTerminal({
  workspaceId,
  workspaceDir,
  terminalSessionId,
  cols = 80,
  rows = 24,
}) {
  if (!config.executionWorkerUrl?.startsWith("https://") || config.workerSharedSecret.length < 32) {
    throw new Error("Remote terminal worker is not configured.");
  }
  if (!/^[a-f0-9-]{36}$/i.test(terminalSessionId || "")) {
    throw new Error("Invalid terminal session identifier.");
  }

  await syncWorkspaceOnRemote({ workspaceId, workspaceDir });
  const base = new URL(config.executionWorkerUrl);
  base.protocol = "wss:";
  base.pathname = "/v1/terminal";
  base.search = "";
  base.searchParams.set("workspaceId", workspaceRuntimeKey(workspaceId));
  base.searchParams.set("sessionId", terminalSessionId);
  base.searchParams.set("cols", String(Math.max(20, Math.min(300, Number(cols) || 80))));
  base.searchParams.set("rows", String(Math.max(5, Math.min(120, Number(rows) || 24))));
  const requestPath = base.pathname + base.search;
  const socket = new WebSocket(base, {
    headers: signedHeaders(requestPath),
    handshakeTimeout: 15000,
    maxPayload: 128 * 1024,
  });

  await new Promise((resolve, reject) => {
    const onOpen = () => { cleanup(); resolve(); };
    const onError = error => { cleanup(); reject(error); };
    const onClose = (code, reason) => {
      cleanup();
      reject(new Error("Remote terminal connection closed during setup (" + code + "): " + reason.toString()));
    };
    const cleanup = () => {
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
  return socket;
}
