/**
 * Workspace Routes — File system and terminal environment endpoints.
 */

import { Router } from "express";
import { optionalAuth } from "../middleware/auth.js";
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

router.get("/files", optionalAuth, listFiles);
router.get("/file", optionalAuth, readFile);
router.post("/file", optionalAuth, writeFile);
router.delete("/file", optionalAuth, deleteFile);
router.post("/move", optionalAuth, moveFile);
router.post("/folder", optionalAuth, createFolder);
router.post("/exec", optionalAuth, execCommand);

// Shell Provider Route
router.get("/terminal/shells", optionalAuth, (req, res) => {
  const shells = LocalBackend.detectAvailableShells();
  res.json({ shells });
});

export default router;
