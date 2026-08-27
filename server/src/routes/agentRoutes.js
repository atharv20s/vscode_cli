import { Router } from "express";
import { requireAuth, optionalAuth } from "../middleware/auth.js";
import { agentLimiter } from "../middleware/rateLimiter.js";
import {
  chatStream,
  listModels,
  getConversations,
  createNewConversation,
  renameConversation,
  removeConversation,
} from "../controllers/agentController.js";

const router = Router();

// SSE streaming chat (fallback when WebSocket is unavailable)
router.post("/chat", requireAuth, agentLimiter, chatStream);

// List available LLM models
router.get("/models", listModels);

// Conversations CRUD
router.get("/conversations", optionalAuth, getConversations);
router.post("/conversations", optionalAuth, createNewConversation);
router.patch("/conversations/:id", optionalAuth, renameConversation);
router.delete("/conversations/:id", optionalAuth, removeConversation);

export default router;
