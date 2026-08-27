/**
 * WebSocket Gateway — Central Routing Layer
 * 
 * Bridges client WebSockets to the central Event Bus and backend services
 * (TerminalSessionManager, ProcessSupervisor, PreviewService, FileSystem, Agent).
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
import { previewService } from "../services/previewService.js";
import { permissionEngine } from "../services/permissionEngine.js";
import { LocalBackend } from "../services/backends/localBackend.js";
import { eventBus, EVENT_TOPICS } from "./eventBus.js";
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

  // 1. Filesystem Events
  eventBus.subscribe(EVENT_TOPICS.FILE_CHANGED, (envelope) => {
    broadcastAll("file.changed", envelope.payload);
  });

  // 2. Agent Background Command Lifecycle
  eventBus.subscribe(EVENT_TOPICS.AGENT_COMMAND_STARTED, (envelope) => {
    broadcastAll("agent.command.started", {
      ...envelope.payload,
      operationId: envelope.operationId,
      turnId: envelope.turnId,
    });
  });

  eventBus.subscribe(EVENT_TOPICS.AGENT_COMMAND_OUTPUT, (envelope) => {
    broadcastAll("agent.command.output", {
      ...envelope.payload,
      operationId: envelope.operationId,
    });
  });

  eventBus.subscribe(EVENT_TOPICS.AGENT_COMMAND_COMPLETED, (envelope) => {
    broadcastAll("agent.command.completed", {
      ...envelope.payload,
      operationId: envelope.operationId,
      turnId: envelope.turnId,
    });
  });

  eventBus.subscribe(EVENT_TOPICS.AGENT_COMMAND_FAILED, (envelope) => {
    broadcastAll("agent.command.failed", {
      ...envelope.payload,
      operationId: envelope.operationId,
      turnId: envelope.turnId,
    });
  });

  // 3. Live Preview Events
  eventBus.subscribe(EVENT_TOPICS.PREVIEW_STARTED, (envelope) => {
    broadcastAll("preview.started", envelope.payload);
  });

  eventBus.subscribe(EVENT_TOPICS.PREVIEW_READY, (envelope) => {
    broadcastAll("preview.ready", envelope.payload);
  });

  eventBus.subscribe(EVENT_TOPICS.PREVIEW_OUTPUT, (envelope) => {
    broadcastAll("preview.output", envelope.payload);
  });

  eventBus.subscribe(EVENT_TOPICS.PREVIEW_STOPPED, (envelope) => {
    broadcastAll("preview.stopped", envelope.payload);
  });

  // 4. Permissions Events
  eventBus.subscribe(EVENT_TOPICS.PERMISSION_REQUESTED, (envelope) => {
    broadcastAll("permission.requested", envelope.payload);
  });

  eventBus.subscribe(EVENT_TOPICS.PERMISSION_RESOLVED, (envelope) => {
    broadcastAll("permission.resolved", envelope.payload);
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
      previewState: previewService.getPreviewState(),
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
        await executionService.stopBackgroundTask(payload.operationId);
      }
      break;

    // Permission Resolution
    case "permission.resolve":
    case "permission_resolve":
      if (payload?.permissionId) {
        permissionEngine.resolvePermission(payload.permissionId, payload.granted, payload.reason);
      }
      break;

    // Shell Providers Query
    case "shells.list":
    case "terminal_shells":
      sendMessage(ws, "terminal.shells", { shells: LocalBackend.detectAvailableShells() });
      break;

    // Hybrid Workstation Bridge Handlers
    case "bridge.register":
      ws.isBridgeNode = true;
      ws.bridgeInfo = payload;
      logger.info(`WebSocket: Registered local workstation bridge node: ${payload?.name}`);
      sendMessage(ws, "bridge.registered", { success: true, nodeId: payload?.nodeId });
      break;

    case "bridge.output":
    case "bridge.completed":
      if (payload?.operationId) {
        eventBus.publish(`bridge.${payload.operationId}`, payload);
      }
      break;

    // Live Application Preview Controls
    case "preview.start":
    case "preview_start":
      await previewService.startPreview(payload);
      break;

    case "preview.stop":
    case "preview_stop":
      await previewService.stopPreview();
      break;

    case "preview.restart":
    case "preview_restart":
      await previewService.restartPreview();
      break;

    case "preview.status":
    case "preview_status":
      sendMessage(ws, "preview.status", previewService.getPreviewState());
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
      eventBus.publish(EVENT_TOPICS.TERMINAL_INPUT, {}, {
        sessionId: ws.sessionId,
        source: "ui",
        actor: "user",
      });
      executionService.writeInteractive(ws.sessionId, payload?.data ?? payload?.command ?? "");
      break;

    // Submitted Command (Enter pressed)
    case "terminal.command.submitted":
      eventBus.publish(EVENT_TOPICS.TERMINAL_COMMAND_SUBMITTED, {
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
      eventBus.publish(EVENT_TOPICS.TERMINAL_PASTE, {
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
      eventBus.publish(EVENT_TOPICS.TERMINAL_RESIZE, {
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
  const { message, images, conversationId, model, systemPrompt, context } = payload || {};

  if (!message && (!images || images.length === 0)) {
    sendMessage(ws, "error", { message: "Missing 'message' or 'images' in chat payload" });
    return;
  }

  const abortController = new AbortController();
  activeAborts.set(ws, abortController);

  logger.info("Agent chat started", {
    user: user?.username || "anonymous",
    messageLength: message?.length || 0,
    imageCount: images?.length || 0,
    model,
    hasContext: Boolean(context),
  });

  try {
    const result = await runAgent({
      message: message || "",
      images: images || [],
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
    eventBus.publish(EVENT_TOPICS.FILE_CHANGED, {
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
