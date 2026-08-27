/**
 * Agent Controller — REST/SSE endpoint for the agent chat.
 *
 * Primary channel is WebSocket, but this SSE endpoint
 * serves as a fallback for environments that don't support WS.
 */

import { runAgent } from "../services/agentService.js";
import { getAvailableModels } from "../services/llmService.js";
import { config } from "../config/env.js";

/**
 * POST /api/agent/chat — SSE streaming chat.
 */
export async function chatStream(req, res) {
  const { message, images, conversationHistory, model, systemPrompt } = req.body;

  if (!message && (!images || images.length === 0)) {
    return res.status(400).json({
      error: "BadRequest",
      message: "Missing 'message' or 'images' in request body.",
    });
  }

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    await runAgent({
      message: message || "",
      images: images || [],
      conversationHistory: conversationHistory || [],
      model: model || undefined,
      systemPrompt: systemPrompt || undefined,
      workspaceDir: config.workspaceRoot,
      onEvent: (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      },
    });
  } catch (err) {
    res.write(
      `data: ${JSON.stringify({ type: "error", data: { message: err.message } })}\n\n`
    );
  }

  res.write("data: [DONE]\n\n");
  res.end();
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
    const userOrSession = req.user?.id || req.user?.sessionId || null;
    const list = listConversations(userOrSession);
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

  try {
    createConversation({
      id: convId,
      sessionId: sid,
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
    updateConversationTitle(id, title.trim());
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
    deleteConversation(id);
    res.json({ success: true, message: "Conversation deleted." });
  } catch (err) {
    res.status(500).json({ error: "DbError", message: err.message });
  }
}
