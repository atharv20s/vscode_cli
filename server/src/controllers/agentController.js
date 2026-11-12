/**
 * Agent Controller — REST/SSE endpoint for the agent chat.
 *
 * Primary channel is WebSocket, but this SSE endpoint
 * serves as a fallback for environments that don't support WS.
 */

import { runAgent } from "../services/agentService.js";
import { getAvailableModels } from "../services/llmService.js";
import { config } from "../config/env.js";
import { getWorkspaceService } from "../services/workspaceService.js";

/**
 * POST /api/agent/chat — SSE streaming chat.
 */
export async function chatStream(req, res) {
  const { message, images = [], model, systemPrompt, conversationId: requestedConversationId } = req.body || {};

  if (!message && (!Array.isArray(images) || images.length === 0)) {
    return res.status(400).json({
      error: "BadRequest",
      message: "Missing 'message' or 'images' in request body.",
    });
  }

  const ownerId = req.user.id;
  const requestedId = typeof requestedConversationId === "string" ? requestedConversationId.trim() : "";
  let conversation = null;
  if (requestedId) {
    conversation = getConversationForUser(requestedId, ownerId);
    if (!conversation) return res.status(404).json({ error: "NotFound", message: "Conversation not found." });
  }

  const convId = conversation?.id || `conv_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
  const sessionId = req.user.sessionId || `sess_${ownerId}`;
  const title = (message || "Image conversation").slice(0, 60);
  const workspaceService = getWorkspaceService(ownerId, req.get("X-Workspace-Id") || "default");

  if (!conversation) {
    try {
      createConversation({
        id: convId,
        sessionId,
        userId: ownerId,
        title,
        model: model || "devstral",
      });
    } catch (error) {
      return res.status(500).json({ error: "ConversationCreateFailed", message: error.message });
    }
  }

  let history = [];
  if (conversation?.messages) {
    try {
      const stored = typeof conversation.messages === "string" ? JSON.parse(conversation.messages) : conversation.messages;
      if (Array.isArray(stored)) history = stored.filter(item => item && item.role && item.role !== "system").slice(-40);
    } catch {
      history = [];
    }
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const abortController = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });

  const emit = event => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  emit({ type: "conversation_started", data: { conversationId: convId, title } });

  try {
    const result = await runAgent({
      message: message || "",
      images,
      conversationHistory: history,
      model: model || undefined,
      systemPrompt: systemPrompt || undefined,
      workspaceDir: workspaceService.workspaceRoot,
      workspaceId: workspaceService.workspaceId,
      workspaceService,
      userId: ownerId,
      sessionId,
      signal: abortController.signal,
      onEvent: emit,
    });

    if (Array.isArray(result?.messages) && result.messages.length) {
      const updated = updateConversationMessagesForUser(convId, result.messages, result.totalTokens || 0, ownerId);
      if (!updated.changes) throw new Error("Conversation ownership changed while the response was running.");
    }
    emit({
      type: "conversation_updated",
      data: { conversationId: convId, title, messageCount: result?.messages?.length || 0 },
    });
  } catch (error) {
    if (!abortController.signal.aborted) emit({ type: "error", data: { message: error.message } });
  } finally {
    if (!res.writableEnded) {
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }
}

/**
 * GET /api/agent/models — List available LLM models.
 */
export function listModels(req, res) {
  const models = getAvailableModels();
  res.json({
    models,
    defaultModel: config.openrouterModel,
    freeModels: models.filter((m) => m.free),
  });
}

import {
  createConversation,
  getConversation,
  getConversationForUser,
  updateConversationMessagesForUser,
  updateConversationTitle,
  deleteConversation,
  listConversations,
} from "../db/database.js";
import { v4 as uuidv4 } from "uuid";

/**
 * GET /api/agent/conversations — List saved conversations.
 */
export function getConversations(req, res) {
  try {
    const list = listConversations(req.user.id);
    res.json({ success: true, conversations: list });
  } catch (err) {
    res.status(500).json({ error: "DbError", message: err.message });
  }
}

/**
 * POST /api/agent/conversations — Create a new conversation.
 */
export function createNewConversation(req, res) {
  const { title, model } = req.body || {};
  const convId = `conv_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
  const convTitle = title || "New Conversation";
  const sid = req.user?.sessionId || "default_session";
  const uid = req.user.id;

  try {
    createConversation({
      id: convId,
      sessionId: sid,
      userId: uid,
      title: convTitle,
      model: model || config.openrouterModel,
    });
    res.status(201).json({ success: true, conversation: { id: convId, title: convTitle } });
  } catch (err) {
    res.status(500).json({ error: "DbError", message: err.message });
  }
}

/**
 * PATCH /api/agent/conversations/:id — Rename a conversation title.
 */
export function renameConversation(req, res) {
  const { id } = req.params;
  const { title } = req.body || {};

  if (!title || typeof title !== "string") {
    return res.status(400).json({ error: "BadRequest", message: "Title is required." });
  }

  try {
    const updated = updateConversationTitle(id, title.trim(), req.user.id);
    if (!updated.changes) return res.status(404).json({ error: "NotFound", message: "Conversation not found." });
    res.json({ success: true, message: "Conversation title updated." });
  } catch (err) {
    res.status(500).json({ error: "DbError", message: err.message });
  }
}

/**
 * DELETE /api/agent/conversations/:id — Delete a conversation.
 */
export function removeConversation(req, res) {
  const { id } = req.params;

  try {
    const deleted = deleteConversation(id, req.user.id);
    if (!deleted.changes) return res.status(404).json({ error: "NotFound", message: "Conversation not found." });
    res.json({ success: true, message: "Conversation deleted." });
  } catch (err) {
    res.status(500).json({ error: "DbError", message: err.message });
  }
}
