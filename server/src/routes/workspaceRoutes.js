/**
 * Workspace Routes — File system and terminal environment endpoints.
 */

import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  listFiles,
  readFile,
  writeFile,
  deleteFile,
  moveFile,
  createFolder,
  execCommand,
} from "../controllers/fileController.js";
import { LocalBackend } from "../services/backends/localBackend.js";
import { config } from "../config/env.js";
import { listWorkspaceSessions, createWorkspaceSession } from "../services/workspaceSessionService.js";
import { resolveWorkspaceShare } from "../services/workspaceCollaborationService.js";

const router = Router();

router.get("/sessions", requireAuth, async (req, res) => {
  try {
    return res.json({
      sessions: await listWorkspaceSessions(req.user.id),
      quotaBytes: config.workspaceQuotaBytes,
      maxFileBytes: config.workspaceMaxFileBytes,
    });
  } catch (error) {
    return res.status(500).json({ error: "WorkspaceRegistryError", message: error.message });
  }
});

router.post("/sessions", requireAuth, async (req, res) => {
  try {
    return res.status(201).json({ session: await createWorkspaceSession(req.user.id, req.body?.name) });
  } catch (error) {
    const status = error.code === "WORKSPACE_SESSION_LIMIT" ? 429 : error.code === "WORKSPACE_BUSY" ? 423 : 400;
    return res.status(status).json({ error: error.code || "BadRequest", message: error.message });
  }
});

router.use(requireAuth, async (req, res, next) => {
  const workspaceId = req.get("X-Workspace-Id") || "default";
  const shareToken = req.get("X-ATH-Share-Token");
  if (shareToken) {
    try {
      const share = await resolveWorkspaceShare(shareToken);
      if (!share) return res.status(404).json({ error: "WorkspaceShareInvalid", message: "This collaboration link is invalid, expired or revoked." });
      if (req.get("X-Workspace-Id") && workspaceId !== share.workspaceId) {
        return res.status(403).json({ error: "WorkspaceShareScopeMismatch" });
      }
      req.workspaceAccess = share;
      if (req.method !== "GET") {
        if (share.permission !== "edit") {
          return res.status(403).json({ error: "WorkspaceReadOnly", message: "This collaboration link has read-only access." });
        }
        if (req.method !== "POST" || req.path !== "/file") {
          return res.status(403).json({ error: "WorkspaceOperationForbidden", message: "Collaborators may create or update files, but only the owner can move, delete, create folders or execute commands." });
        }
        if (!req.get("If-Match") && req.get("If-None-Match") !== "*") {
          return res.status(428).json({ error: "WorkspaceVersionRequired", message: "Collaborative file writes require If-Match or If-None-Match: *." });
        }
      }
      return next();
    } catch (error) {
      return res.status(503).json({ error: "WorkspaceShareUnavailable", message: "Workspace collaboration storage is unavailable." });
    }
  }
  req.workspaceAccess = { ownerUserId: req.user.id, workspaceId, permission: "owner" };
  if (workspaceId === "default") return next();
  try {
    const sessions = await listWorkspaceSessions(req.user.id);
    if (!sessions.some(session => session.id === workspaceId)) {
      return res.status(404).json({ error: "WorkspaceNotFound", message: "Workspace does not exist for this account." });
    }
    return next();
  } catch (error) {
    return res.status(503).json({ error: "WorkspaceRegistryUnavailable", message: "Workspace registry is unavailable." });
  }
});

router.get("/files", listFiles);
router.get("/file", readFile);
router.post("/file", writeFile);
router.delete("/file", deleteFile);
router.post("/move", moveFile);
router.post("/folder", createFolder);
router.post("/exec", execCommand);

// Shell Provider Route
router.get("/terminal/shells", (req, res) => {
  const shells = config.executionRuntime === "docker" ? ["bash", "sh"] : config.executionRuntime === "remote" ? [] : LocalBackend.detectAvailableShells();
  res.json({ shells });
});

export default router;
