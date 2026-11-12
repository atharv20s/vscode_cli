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

router.get("/files", requireAuth, listFiles);
router.get("/file", requireAuth, readFile);
router.post("/file", requireAuth, writeFile);
router.delete("/file", requireAuth, deleteFile);
router.post("/move", requireAuth, moveFile);
router.post("/folder", requireAuth, createFolder);
router.post("/exec", requireAuth, execCommand);

// Shell Provider Route
router.get("/terminal/shells", requireAuth, (req, res) => {
  const shells = config.executionRuntime === "docker" ? ["bash", "sh"] : config.executionRuntime === "remote" ? [] : LocalBackend.detectAvailableShells();
  res.json({ shells });
});

export default router;
