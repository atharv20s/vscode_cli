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

const router = Router();

router.get("/files", requireAuth, listFiles);
router.get("/file", requireAuth, readFile);
router.post("/file", requireAuth, writeFile);
router.delete("/file", requireAuth, deleteFile);
router.post("/move", requireAuth, moveFile);
router.post("/folder", requireAuth, createFolder);
router.post("/exec", requireAuth, execCommand);

// Shell Provider Route
router.get("/terminal/shells", requireAuth, (req, res) => {
  const shells = LocalBackend.detectAvailableShells();
  res.json({ shells });
});

export default router;
