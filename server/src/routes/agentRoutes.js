import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
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
router.get("/conversations", getConversations);
router.post("/conversations", createNewConversation);
router.patch("/conversations/:id", renameConversation);
router.delete("/conversations/:id", removeConversation);

export default router;
