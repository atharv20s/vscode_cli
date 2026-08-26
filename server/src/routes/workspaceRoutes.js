/**
 * Workspace Routes — File system operations within the user's workspace.
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

const router = Router();

router.get("/files", optionalAuth, listFiles);
router.get("/file", optionalAuth, readFile);
router.post("/file", optionalAuth, writeFile);
router.delete("/file", optionalAuth, deleteFile);
router.post("/move", optionalAuth, moveFile);
router.post("/folder", optionalAuth, createFolder);
router.post("/exec", optionalAuth, execCommand);

export default router;
