/**
 * WebSocket Gateway — Central Routing Layer
 * 
 * Bridges client WebSockets to the central Event Bus and backend services
 * (TerminalSessionManager, ProcessSupervisor, PreviewService, FileSystem, Agent).
 */

import path from "path";
import crypto from "crypto";
import { WebSocketServer } from "ws";
import { verifyToken } from "../middleware/auth.js";
import { runAgent } from "../services/agentService.js";
import { config } from "../config/env.js";
import { getWorkspaceService } from "../services/workspaceService.js";
import { ensureWorkspaceSession } from "../services/workspaceSessionService.js";
import { logger } from "../config/logger.js";
import {
  addConnection,
  removeConnection,
  recordMessage,
  sendMessage,
  disconnectIdle,
} from "./connectionManager.js";
import { executionService } from "../services/executionService.js";
import { connectRemoteTerminal } from "../services/remoteTerminalClient.js";
import { getPreviewService } from "../services/previewService.js";
import { permissionEngine } from "../services/permissionEngine.js";
import { LocalBackend } from "../services/backends/localBackend.js";
import { eventBus, EVENT_TOPICS } from "./eventBus.js";
import { createConversation, updateConversationMessages, getConversation, listConversations, findOrCreateUserSession } from "../db/database.js";

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
        executionService.detachInteractive(ws.terminalSessionId, ws);
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
    executionService.cleanupIdleSessions(config.terminalIdleTtlMs);
  }, 5 * 60 * 1000);

  wss.on("close", () => {
    clearInterval(heartbeatInterval);
    clearInterval(idleCleanupInterval);
  });

  const broadcastScoped = (type, envelope, payload = envelope.payload) => {
    if (!envelope.workspaceId) return;
    wss.clients.forEach(client => {
      if (client.workspaceId === envelope.workspaceId) sendMessage(client, type, payload);
    });
  };

  // 1. Filesystem Events
  eventBus.subscribe(EVENT_TOPICS.FILE_CHANGED, (envelope) => {
    broadcastScoped("file.changed", envelope);
  });
  eventBus.subscribe(EVENT_TOPICS.FILE_CREATED, (envelope) => {
    broadcastScoped("file.created", envelope);
  });
  eventBus.subscribe(EVENT_TOPICS.FILE_DELETED, (envelope) => {
    broadcastScoped("file.deleted", envelope);
  });
  eventBus.subscribe(EVENT_TOPICS.FILE_RENAMED, (envelope) => {
    broadcastScoped("file.renamed", envelope);
  });

  // 2. Agent Background Command Lifecycle
  eventBus.subscribe(EVENT_TOPICS.AGENT_COMMAND_STARTED, (envelope) => {
    broadcastScoped("agent.command.started", envelope, {
      ...envelope.payload,
      operationId: envelope.operationId,
      turnId: envelope.turnId,
    });
  });

  eventBus.subscribe(EVENT_TOPICS.AGENT_COMMAND_OUTPUT, (envelope) => {
    broadcastScoped("agent.command.output", envelope, {
      ...envelope.payload,
      operationId: envelope.operationId,
    });
  });

  eventBus.subscribe(EVENT_TOPICS.AGENT_COMMAND_COMPLETED, (envelope) => {
    broadcastScoped("agent.command.completed", envelope, {
      ...envelope.payload,
      operationId: envelope.operationId,
      turnId: envelope.turnId,
    });
  });

  eventBus.subscribe(EVENT_TOPICS.AGENT_COMMAND_FAILED, (envelope) => {
    broadcastScoped("agent.command.failed", envelope, {
      ...envelope.payload,
      operationId: envelope.operationId,
      turnId: envelope.turnId,
    });
  });

  // 3. Live Preview Events
  eventBus.subscribe(EVENT_TOPICS.PREVIEW_STARTED, (envelope) => {
    broadcastScoped("preview.started", envelope);
  });

  eventBus.subscribe(EVENT_TOPICS.PREVIEW_READY, (envelope) => {
    broadcastScoped("preview.ready", envelope);
  });

  eventBus.subscribe(EVENT_TOPICS.PREVIEW_OUTPUT, (envelope) => {
    broadcastScoped("preview.output", envelope);
  });

  eventBus.subscribe(EVENT_TOPICS.PREVIEW_STOPPED, (envelope) => {
    broadcastScoped("preview.stopped", envelope);
  });

  // 4. Permissions Events
  eventBus.subscribe(EVENT_TOPICS.PERMISSION_REQUESTED, (envelope) => {
    broadcastScoped("permission.requested", envelope);
  });

  eventBus.subscribe(EVENT_TOPICS.PERMISSION_RESOLVED, (envelope) => {
    broadcastScoped("permission.resolved", envelope);
  });

  wss.on("connection", async (ws, req) => {
    ws.isAlive = true;
    ws.sessionId = `conn_${crypto.randomUUID()}`;

    // Browser WebSocket APIs cannot set Authorization headers. Carry the JWT
    // as a negotiated subprotocol instead of a query parameter so reverse
    // proxies and access logs do not record it as part of the request URL.
    const url = new URL(req.url, `http://${req.headers.host}`);
    const offeredProtocols = String(req.headers["sec-websocket-protocol"] || "")
      .split(",").map(value => value.trim()).filter(Boolean);
    const token = offeredProtocols[0] === "ath-auth" ? offeredProtocols[1] : null;
    let user = null;

    if (token) {
      user = verifyToken(token);
      if (user?.sessionId) {
        ws.sessionId = user.sessionId;
      }
    }

    if (!user && !config.isDev) {
      ws.close(4001, "Authentication required");
      return;
    }

    ws.userId = user?.id || ws.sessionId;
    const requestedWorkspace = url.searchParams.get("workspace") || "default";
    try {
      await ensureWorkspaceSession(ws.userId, requestedWorkspace);
      ws.workspaceService = getWorkspaceService(ws.userId, requestedWorkspace);
    } catch {
      ws.close(4003, "Invalid workspace");
      return;
    }
    ws.workspaceKey = requestedWorkspace;
    ws.workspaceId = ws.workspaceService.workspaceId;
    const requestedTerminalId = url.searchParams.get("terminalSessionId") || "";
    ws.terminalSessionId = /^[a-f0-9-]{36}$/i.test(requestedTerminalId) ? requestedTerminalId : crypto.randomUUID();
    ws.previewService = getPreviewService(ws.workspaceId);

    addConnection(ws, user || { id: ws.userId, username: "guest" });

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
      executionService.detachInteractive(ws.terminalSessionId, ws);
      try { ws.remoteTerminal?.close(); } catch {}
      removeConnection(ws);
    });

    ws.on("error", (err) => {
      logger.error("WebSocket error", { error: err.message });
      executionService.detachInteractive(ws.terminalSessionId, ws);
      removeConnection(ws);
    });

    // Send welcome and metadata
    sendMessage(ws, "connected", {
      message: "Connected to Agentic CLI Server",
      user: user ? { id: user.id, username: user.username } : null,
      sessionId: ws.sessionId,
      workspace: path.basename(ws.workspaceService.workspaceRoot),
      previewState: ws.previewService.getPreviewState(),
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
        permissionEngine.resolvePermission(payload.permissionId, payload.granted, payload.reason, ws.workspaceId);
      }
      break;

    // Shell Providers Query
    case "shells.list":
    case "terminal_shells":
      sendMessage(ws, "terminal.shells", { shells: config.executionRuntime === "docker" ? ["bash", "sh"] : config.executionRuntime === "remote" ? [] : LocalBackend.detectAvailableShells() });
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
      await ws.previewService.startPreview({ ...payload, cwd: ws.workspaceService.workspaceRoot });
      break;

    case "preview.stop":
    case "preview_stop":
      await ws.previewService.stopPreview();
      break;

    case "preview.restart":
    case "preview_restart":
      await ws.previewService.restartPreview();
      break;

    case "preview.status":
    case "preview_status":
      sendMessage(ws, "preview.status", ws.previewService.getPreviewState());
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
      if (config.executionRuntime === "remote") {
        try { ws.remoteTerminal?.close(); } catch {}
        const remote = await connectRemoteTerminal({
          workspaceId: ws.workspaceId,
          workspaceDir: ws.workspaceService.workspaceRoot,
          terminalSessionId: ws.terminalSessionId,
          cols: payload?.cols || 80,
          rows: payload?.rows || 24,
        });
        ws.remoteTerminal = remote;
        remote.on("message", raw => {
          let event;
          try { event = JSON.parse(raw.toString("utf8")); } catch { return; }
          if (event?.type && event?.payload) sendMessage(ws, event.type, event.payload);
        });
        remote.on("close", (code, reason) => {
          if (ws.remoteTerminal === remote) ws.remoteTerminal = null;
          if (ws.readyState === 1) sendMessage(ws, "terminal.state", {
            sessionId: ws.terminalSessionId,
            state: "disconnected",
            code,
            reason: reason?.toString?.() || "",
            reconnectable: true,
          });
        });
        remote.on("error", error => {
          logger.warn("Remote terminal tunnel error", { error: error.message });
          if (ws.readyState === 1) sendMessage(ws, "error", { message: "Remote terminal connection failed: " + error.message });
        });
      } else {
        await executionService.spawnInteractiveSession(ws.terminalSessionId, {
          shellType: payload?.shell || "bash",
          cols: payload?.cols || 80,
          rows: payload?.rows || 24,
          workspaceDir: ws.workspaceService.workspaceRoot,
          workspaceId: ws.workspaceId,
          userId: ws.userId,
          ws,
        });
      }
      break;

    // Raw Keystroke Input
    case "terminal_input":
    case "terminal.input":
    case "terminal.keystroke":
      eventBus.publish(EVENT_TOPICS.TERMINAL_INPUT, {}, {
        sessionId: ws.terminalSessionId,
        workspaceId: ws.workspaceId,
        source: "ui",
        actor: "user",
      });
      if (ws.remoteTerminal?.readyState === 1) {
        ws.remoteTerminal.send(JSON.stringify({ type: "terminal.input", payload: { data: payload?.data ?? payload?.command ?? "" } }));
      } else {
        executionService.writeInteractive(ws.terminalSessionId, payload?.data ?? payload?.command ?? "", ws.userId, ws.workspaceId);
      }
      break;

    // Submitted Command (Enter pressed)
    case "terminal.command.submitted":
      eventBus.publish(EVENT_TOPICS.TERMINAL_COMMAND_SUBMITTED, {
        command: payload?.command || "",
        cwd: payload?.cwd || config.workspaceRoot,
      }, {
        sessionId: ws.terminalSessionId,
        workspaceId: ws.workspaceId,
        source: "ui",
        actor: "user",
      });
      break;

    // Clipboard Paste into Terminal
    case "terminal.paste":
      eventBus.publish(EVENT_TOPICS.TERMINAL_PASTE, {
        text: payload?.text || "",
      }, {
        sessionId: ws.terminalSessionId,
        workspaceId: ws.workspaceId,
        source: "ui",
        actor: "user",
      });
      if (ws.remoteTerminal?.readyState === 1) {
        ws.remoteTerminal.send(JSON.stringify({ type: "terminal.paste", payload: { text: payload?.text || "" } }));
      } else {
        executionService.writeInteractive(ws.terminalSessionId, payload?.text || "", ws.userId, ws.workspaceId);
      }
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
      if (ws.remoteTerminal?.readyState === 1) {
        ws.remoteTerminal.send(JSON.stringify({ type: "terminal.resize", payload: { cols: payload?.cols, rows: payload?.rows } }));
      } else {
        executionService.resizeInteractive(ws.terminalSessionId, payload?.cols, payload?.rows, ws.userId, ws.workspaceId);
      }
      break;

    default:
      sendMessage(ws, "error", { message: `Unknown message type: ${type}` });
  }
}

/**
 * Handle agent chat messages — streams agent events back over WS.
 */
async function handleChat(ws, payload, user) {
  const { message, images, conversationId, model, systemPrompt, context, conversationHistory } = payload || {};

  if (!message && (!images || images.length === 0)) {
    sendMessage(ws, "error", { message: "Missing 'message' or 'images' in chat payload" });
    return;
  }

  const abortController = new AbortController();
  activeAborts.set(ws, abortController);

  // Resolve the session ID tied to this user (so conversations are scoped per-user)
  const userId = user?.id || user?.sessionId || ws.userId || null;
  const sessionId = ws.sessionId || `sess_guest_${Date.now()}`;

  logger.info("Agent chat started", {
    user: user?.username || "anonymous",
    userId,
    sessionId,
    messageLength: message?.length || 0,
    imageCount: images?.length || 0,
    model,
    hasContext: Boolean(context),
  });

  // Build the conversation history from the client payload (trimmed to last 40 turns to stay within context)
  const sanitizedHistory = Array.isArray(conversationHistory)
    ? conversationHistory
        .filter((m) => m.role && m.content)
        .slice(-40)
        .map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }))
    : [];

  try {
    const result = await runAgent({
      message: message || "",
      images: images || [],
      context,
      conversationHistory: sanitizedHistory,
      model: model || undefined,
      systemPrompt: systemPrompt || undefined,
      workspaceDir: ws.workspaceService.workspaceRoot,
      workspaceId: ws.workspaceId,
      workspaceKey: ws.workspaceKey,
      workspaceService: ws.workspaceService,
      userId: ws.userId,
      sessionId,
      signal: abortController.signal,
      onEvent: (event) => {
        sendMessage(ws, event.type, {
          ...event.data,
          conversationId,
        });
      },
    });

    // Persist conversation and messages to SQLite scoped by user identity
    try {
      let convId = conversationId || `conv_${Date.now()}`;
      const existing = getConversation(convId);
      const convTitle = (message || "").slice(0, 60) + ((message || "").length > 60 ? "..." : "");

      if (!existing) {
        createConversation({
          id: convId,
          sessionId,
          userId,           // store user identity directly
          title: convTitle,
          model: model || "devstral",
        });
      }

      if (result?.messages?.length) {
        updateConversationMessages(convId, result.messages, result.totalTokens || 0);
      }

      sendMessage(ws, "conversation_updated", {
        conversationId: convId,
        title: convTitle,
        messageCount: result?.messages?.length || 0,
      });
    } catch (dbErr) {
      logger.warn(`Failed to persist conversation: ${dbErr.message}`);
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
    const result = await ws.workspaceService.readFile(filePath);
    sendMessage(ws, "file_content", { path: result.path, content: result.content });
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
    const result = await ws.workspaceService.writeFile(filePath, content, {
      source: "ui",
      actor: ws.userId,
    });
    sendMessage(ws, "file_saved", { path: result.path, size: result.size });
  } catch (err) {
    sendMessage(ws, "error", { message: `File save failed: ${err.message}` });
  }
}
