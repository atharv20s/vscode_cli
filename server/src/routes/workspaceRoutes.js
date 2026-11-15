/**
 * Workspace Routes — File system and terminal environment endpoints.
 */

import { Router } from "express";
import fs from "fs/promises";
import path from "path";
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
import { getWorkspaceService } from "../services/workspaceService.js";
import { pullWorkspaceFromRemote } from "../services/remoteExecutionWorker.js";

const router = Router();

const SEARCH_IGNORED = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", ".cache", ".worktrees", ".agent-runs", "vendor", "target", ".venv", "venv"]);
const SEARCH_MAX_FILES = 2000;
const SEARCH_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const SEARCH_MAX_FILE_BYTES = 512 * 1024;
const SEARCH_MAX_RESULTS = 300;

async function searchWorkspace(req, res) {
  const query = String(req.query.q || "");
  if (!query.trim()) return res.status(400).json({ error: "MissingSearchQuery", message: "Provide a non-empty q parameter." });
  if (query.length > 200) return res.status(400).json({ error: "SearchQueryTooLong", message: "Search queries are limited to 200 characters." });
  const workspace = getWorkspaceService(req.workspaceAccess?.ownerUserId || req.user.id, req.workspaceAccess?.workspaceId || req.get("X-Workspace-Id") || "default");
  const useRegex = req.query.regex === "true";
  const caseInsensitive = req.query.caseInsensitive !== "false";
  let matcher = null;
  try {
    if (useRegex && (query.length > 120 || query.includes("\\1") || query.includes("(?=") || query.includes("(?!") || query.includes("(?<") || query.includes(")+") || query.includes(")*"))) {
      return res.status(400).json({ error: "UnsafeSearchPattern", message: "This regular expression uses constructs that are too expensive for workspace search." });
    }
    if (useRegex) matcher = new RegExp(query, caseInsensitive ? "i" : "");
  } catch {
    return res.status(400).json({ error: "InvalidSearchPattern", message: "The regular expression is invalid." });
  }
  try {
    if (config.executionRuntime === "remote") await pullWorkspaceFromRemote({ workspaceId: workspace.workspaceId, workspaceDir: workspace.workspaceRoot });
    const root = workspace.resolvePath(".").resolved;
    const stack = [root], results = [];
    let scannedFiles = 0, scannedBytes = 0, truncated = false;
    while (stack.length && !truncated) {
      const directory = stack.pop();
      let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); }
      catch (error) { if (error.code === "ENOENT" || error.code === "EACCES") continue; throw error; }
      for (const entry of entries) {
        if (SEARCH_IGNORED.has(entry.name) || entry.name.startsWith(".ath-") || entry.isSymbolicLink()) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) { stack.push(absolute); continue; }
        if (!entry.isFile()) continue;
        scannedFiles++;
        if (scannedFiles > SEARCH_MAX_FILES) { truncated = true; break; }
        let stat, source;
        try { stat = await fs.stat(absolute); if (stat.size > SEARCH_MAX_FILE_BYTES) continue; scannedBytes += stat.size; if (scannedBytes > SEARCH_MAX_TOTAL_BYTES) { truncated = true; break; } source = await fs.readFile(absolute, "utf8"); }
        catch { continue; }
        if (source.includes("\u0000")) continue;
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        const lines = source.split(String.fromCharCode(10));
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index];
          if (line.length > 10000) continue;
          const haystack = caseInsensitive && !useRegex ? line.toLowerCase() : line;
          const needle = caseInsensitive && !useRegex ? query.toLowerCase() : query;
          const match = useRegex ? (matcher.lastIndex = 0, matcher.exec(line)) : (haystack.includes(needle) ? { index: haystack.indexOf(needle) } : null);
          if (!match) continue;
          results.push({ file: relative, line: index + 1, col: match.index + 1, preview: line.trim().slice(0, 240) });
          if (results.length >= SEARCH_MAX_RESULTS) { truncated = true; break; }
        }
        if (truncated) break;
      }
    }
    return res.json({ query, results, scannedFiles: Math.min(scannedFiles, SEARCH_MAX_FILES), scannedBytes, truncated });
  } catch {
    return res.status(500).json({ error: "WorkspaceSearchFailed", message: "Unable to search this workspace." });
  }
}


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

router.get("/search", searchWorkspace);
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
