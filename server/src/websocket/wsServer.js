/**
 * WebSocket Gateway — Central Routing Layer
 * 
 * Bridges client WebSockets to the central Event Bus and backend services
 * (TerminalSessionManager, ExecutionService, FileSystem, Agent).
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
  broadcastAll,
  disconnectIdle,
} from "./connectionManager.js";
import { executionService } from "../services/executionService.js";
import { eventBus } from "./eventBus.js";
import { createConversation, updateConversationMessages } from "../db/database.js";

/** Heartbeat interval in ms */
const HEARTBEAT_INTERVAL = 30000;

const activeAborts = new Map(); // ws -> AbortController

/**
 * Initialize WebSocket server on an existing HTTP server.
 */
export function initWebSocketServer(httpServer) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
  });

  // Heartbeat check
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        logger.warn("Terminating dead WebSocket connection");
        executionService.killInteractive(ws.sessionId);
        removeConnection(ws);
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL);

  // Idle cleanup
  const idleCleanupInterval = setInterval(() => {
    disconnectIdle();
  }, 5 * 60 * 1000);

  wss.on("close", () => {
    clearInterval(heartbeatInterval);
    clearInterval(idleCleanupInterval);
  });

  // Forward EventBus events to connected clients
  eventBus.subscribe("file.changed", (envelope) => {
    broadcastAll("file.changed", envelope.payload);
  });

  eventBus.subscribe("agent.command.started", (envelope) => {
    broadcastAll("agent.command.started", {
      ...envelope.payload,
      operationId: envelope.operationId,
      turnId: envelope.turnId,
    });
  });

  eventBus.subscribe("agent.command.output", (envelope) => {
    broadcastAll("agent.command.output", {
      ...envelope.payload,
      operationId: envelope.operationId,
    });
  });

  eventBus.subscribe("agent.command.completed", (envelope) => {
    broadcastAll("agent.command.completed", {
      ...envelope.payload,
      operationId: envelope.operationId,
      turnId: envelope.turnId,
    });
  });

  wss.on("connection", (ws, req) => {
    ws.isAlive = true;
    ws.sessionId = `sess_${Math.random().toString(36).slice(2, 9)}`;

    // Authenticate via query param: /ws?token=<jwt>
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    let user = null;

    if (token) {
      user = verifyToken(token);
    }

    if (!user && !config.isDev) {
      ws.close(4001, "Authentication required");
      return;
    }

    addConnection(ws, user || { id: "anonymous", username: "anonymous" });

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", async (raw) => {
      recordMessage(ws);

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        sendMessage(ws, "error", { message: "Invalid JSON" });
        return;
      }

      try {
        await handleMessage(ws, msg, user);
      } catch (err) {
        logger.error("WebSocket message handler error", { error: err.message });
        sendMessage(ws, "error", { message: err.message });
      }
    });

    ws.on("close", () => {
      executionService.killInteractive(ws.sessionId);
      removeConnection(ws);
    });

    ws.on("error", (err) => {
      logger.error("WebSocket error", { error: err.message });
      executionService.killInteractive(ws.sessionId);
      removeConnection(ws);
    });

    // Send welcome and metadata
    sendMessage(ws, "connected", {
      message: "Connected to Agentic CLI Server",
      user: user ? { id: user.id, username: user.username } : null,
      sessionId: ws.sessionId,
      workspace: path.basename(config.workspaceRoot),
    });
  });

  return wss;
}

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

    case "agent.command.stop":
      if (payload?.operationId) {
        executionService.stopBackgroundTask(payload.operationId);
      }
      break;

    case "file_read":
    case "file.read":
      await handleFileRead(ws, payload);
      break;

    case "file_save":
    case "file.write":
      await handleFileSave(ws, payload);
      break;

    // Terminal Session Lifecycle
    case "terminal_init":
    case "terminal.init":
      await executionService.spawnInteractiveSession(ws.sessionId, {
        shellType: payload?.shell || "powershell",
        cols: payload?.cols || 80,
        rows: payload?.rows || 24,
        ws,
      });
      break;

    // Raw Keystroke Input
    case "terminal_input":
    case "terminal.input":
    case "terminal.keystroke":
      executionService.writeInteractive(ws.sessionId, payload?.data ?? payload?.command ?? "");
      break;

    // Submitted Command (Enter pressed)
    case "terminal.command.submitted":
      eventBus.publish("terminal.command.submitted", {
        command: payload?.command || "",
        cwd: payload?.cwd || config.workspaceRoot,
      }, {
        sessionId: ws.sessionId,
        source: "ui",
        actor: "user",
      });
      break;

    // Clipboard Paste into Terminal
    case "terminal.paste":
      eventBus.publish("terminal.paste", {
        text: payload?.text || "",
      }, {
        sessionId: ws.sessionId,
        source: "ui",
        actor: "user",
      });
      executionService.writeInteractive(ws.sessionId, payload?.text || "");
      break;

    // Terminal Dimensions Resize
    case "terminal_resize":
    case "terminal.resize":
      eventBus.publish("terminal.resize", {
        cols: payload?.cols,
        rows: payload?.rows,
      }, {
        sessionId: ws.sessionId,
        source: "ui",
        actor: "user",
      });
      executionService.resizeInteractive(ws.sessionId, payload?.cols, payload?.rows);
      break;

    default:
      sendMessage(ws, "error", { message: `Unknown message type: ${type}` });
  }
}

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
      sessionId: ws.sessionId,
      signal: abortController.signal,
      onEvent: (event) => {
        sendMessage(ws, event.type, {
          ...event.data,
          conversationId,
        });
      },
    });

    if (user?.id && user.id !== "anonymous") {
      try {
        let convId = conversationId;
        if (!convId) {
          const newConv = createConversation(
            user.id,
            message.slice(0, 50) + (message.length > 50 ? "..." : "")
          );
          convId = newConv.id;
        }

        if (result?.messages?.length) {
          updateConversationMessages(convId, result.messages);
        }

        sendMessage(ws, "conversation_updated", {
          conversationId: convId,
          messageCount: result.messages.length,
        });
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

    // Emit lightweight metadata event
    eventBus.publish("file.changed", {
      path: filePath,
      operation: "modify",
      version: Date.now(),
    }, {
      source: "ui",
      actor: "user",
    });

    sendMessage(ws, "file_saved", { path: filePath, size: Buffer.byteLength(content) });
  } catch (err) {
    sendMessage(ws, "error", { message: `File save failed: ${err.message}` });
  }
}
