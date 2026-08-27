/**
 * WebSocket Server — Real-time bidirectional communication.
 *
 * Uses raw `ws` library (NOT Socket.IO) to demonstrate
 * deep protocol understanding.
 *
 * Features:
 * - JWT auth on connection (token in query param)
 * - Heartbeat/ping-pong keep-alive (30s interval)
 * - Message routing by type
 * - Agent chat streaming over WebSocket
 * - File save/load operations
 */

import fs from "fs/promises";
import path from "path";
import { WebSocketServer } from "ws";
import { verifyToken } from "../middleware/auth.js";
import { runAgent } from "../services/agentService.js";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import {
  addConnection,
  removeConnection,
  recordMessage,
  sendMessage,
  disconnectIdle,
} from "./connectionManager.js";
import { initTerminal, handleTerminalInput, killTerminal, resizeTerminal } from "./terminalManager.js";

/** Heartbeat interval in ms */
const HEARTBEAT_INTERVAL = 30000;

/**
 * Initialize WebSocket server on an existing HTTP server.
 * @param {import('http').Server} httpServer
 */
export function initWebSocketServer(httpServer) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
  });

  logger.info("WebSocket server initialized at /ws");

  // Heartbeat — detect dead connections
  const heartbeatInterval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL);

  // Idle connection cleanup every 5 minutes
  const idleCleanupInterval = setInterval(() => {
    disconnectIdle(30 * 60 * 1000); // 30 min idle timeout
  }, 5 * 60 * 1000);

  wss.on("close", () => {
    clearInterval(heartbeatInterval);
    clearInterval(idleCleanupInterval);
  });

  wss.on("connection", (ws, req) => {
    ws.isAlive = true;

    // Authenticate via query param: /ws?token=<jwt>
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    let user = null;

    if (token) {
      user = verifyToken(token);
    }

    // Allow anonymous connections in dev mode
    if (!user && !config.isDev) {
      ws.close(4001, "Authentication required");
      return;
    }

    // Register connection
    addConnection(ws, user || { id: "anonymous", username: "anonymous" });

    // Respond to pongs (heartbeat)
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    // Handle messages
    ws.on("message", async (raw) => {
      recordMessage(ws);

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        sendMessage(ws, "error", { message: "Invalid JSON" });
        return;
      }

      // Route by message type
      try {
        await handleMessage(ws, msg, user);
      } catch (err) {
        logger.error("WebSocket message handler error", { error: err.message });
        sendMessage(ws, "error", { message: err.message });
      }
    });

// Cleanup on close
    ws.on("close", () => {
      killTerminal(ws);
      removeConnection(ws);
    });

    ws.on("error", (err) => {
      logger.error("WebSocket error", { error: err.message });
      killTerminal(ws);
      removeConnection(ws);
    });

    // Send welcome
    sendMessage(ws, "connected", {
      message: "Connected to Agentic CLI Server",
      user: user ? { id: user.id, username: user.username } : null,
    });
  });

  return wss;
}

const activeAborts = new Map(); // ws -> AbortController

/**
 * Route incoming WebSocket messages by type.
 */
async function handleMessage(ws, msg, user) {
  const { type, payload } = msg;

  switch (type) {
    case "ping":
      sendMessage(ws, "pong", { timestamp: Date.now() });
      break;

    case "chat":
      await handleChat(ws, payload, user);
      break;

    case "abort":
      if (activeAborts.has(ws)) {
        activeAborts.get(ws).abort();
        activeAborts.delete(ws);
        sendMessage(ws, "aborted", { message: "Generation aborted by user." });
      }
      break;

    case "file_read":
      await handleFileRead(ws, payload);
      break;

    case "file_save":
      await handleFileSave(ws, payload);
      break;

    case "terminal_init":
      initTerminal(ws, payload?.shell || "powershell", payload?.cols, payload?.rows);
      break;

    case "terminal_input":
      handleTerminalInput(ws, payload?.command || "");
      break;

    case "terminal_resize":
      resizeTerminal(ws, payload?.cols, payload?.rows);
      break;

    default:
      sendMessage(ws, "error", { message: `Unknown message type: ${type}` });
  }
}

import { createConversation, updateConversationMessages } from "../db/database.js";

/**
 * Handle agent chat messages — streams agent events back over WS.
 */
async function handleChat(ws, payload, user) {
  const { message, conversationId, model, systemPrompt, context } = payload || {};

  if (!message) {
    sendMessage(ws, "error", { message: "Missing 'message' in chat payload" });
    return;
  }

  const abortController = new AbortController();
  activeAborts.set(ws, abortController);

  logger.info("Agent chat started", {
    user: user?.username || "anonymous",
    messageLength: message.length,
    model,
    hasContext: Boolean(context),
  });

  try {
    const result = await runAgent({
      message,
      context,
      conversationHistory: [],
      model: model || undefined,
      systemPrompt: systemPrompt || undefined,
      workspaceDir: config.workspaceRoot,
      signal: abortController.signal,
      onEvent: (event) => {
        sendMessage(ws, event.type, {
          ...event.data,
          conversationId,
        });
      },
    });

    if (conversationId) {
      try {
        updateConversationMessages(conversationId, result.messages, result.totalTokens);
      } catch {}
    }
  } catch (err) {
    if (!abortController.signal.aborted) {
      sendMessage(ws, "error", { message: err.message, conversationId });
    }
  } finally {
    activeAborts.delete(ws);
  }
}

/**
 * Handle file read requests over WebSocket.
 */
async function handleFileRead(ws, payload) {
  const { path: filePath } = payload || {};
  if (!filePath) {
    sendMessage(ws, "error", { message: "Missing 'path' in file_read payload" });
    return;
  }

  try {
    const resolved = path.resolve(config.workspaceRoot, filePath);

    if (!resolved.startsWith(path.resolve(config.workspaceRoot))) {
      sendMessage(ws, "error", { message: "Access denied: path outside workspace" });
      return;
    }

    const content = await fs.readFile(resolved, "utf8");
    sendMessage(ws, "file_content", { path: filePath, content });
  } catch (err) {
    sendMessage(ws, "error", { message: `File read failed: ${err.message}` });
  }
}

/**
 * Handle file save requests over WebSocket.
 */
async function handleFileSave(ws, payload) {
  const { path: filePath, content } = payload || {};
  if (!filePath || content === undefined) {
    sendMessage(ws, "error", { message: "Missing 'path' or 'content' in file_save payload" });
    return;
  }

  try {
    const resolved = path.resolve(config.workspaceRoot, filePath);

    if (!resolved.startsWith(path.resolve(config.workspaceRoot))) {
      sendMessage(ws, "error", { message: "Access denied: path outside workspace" });
      return;
    }

    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf8");
    sendMessage(ws, "file_saved", { path: filePath, size: Buffer.byteLength(content) });
  } catch (err) {
    sendMessage(ws, "error", { message: `File save failed: ${err.message}` });
  }
}
