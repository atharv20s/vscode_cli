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
import { buildRepositorySymbolIndex } from "../services/repoSymbolIndex.js";

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


const SYMBOL_SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", ".cache", ".worktrees", ".agent-runs", "vendor", "target", ".venv", "venv"]);
async function collectSymbolFiles(root) {
  const files = [];
  const stack = [{ absolute: root, relative: "" }];
  let visited = 0;
  while (stack.length && visited < 5000 && files.length < 2200) {
    const current = stack.pop();
    let entries;
    try { entries = await fs.readdir(current.absolute, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++visited > 5000 || files.length >= 2200) break;
      if (entry.isSymbolicLink() || SYMBOL_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".ath-")) continue;
      const relative = current.relative ? current.relative + "/" + entry.name : entry.name;
      const absolute = path.join(current.absolute, entry.name);
      if (entry.isDirectory()) stack.push({ absolute, relative });
      else if (entry.isFile()) files.push(relative);
    }
  }
  return files;
}
async function symbolIndexForRequest(req) {
  const workspace = getWorkspaceService(req.workspaceAccess?.ownerUserId || req.user.id, req.workspaceAccess?.workspaceId || req.get("X-Workspace-Id") || "default");
  if (config.executionRuntime === "remote") await pullWorkspaceFromRemote({ workspaceId: workspace.workspaceId, workspaceDir: workspace.workspaceRoot });
  const files = await collectSymbolFiles(workspace.workspaceRoot);
  return buildRepositorySymbolIndex(workspace.workspaceRoot, files, "", { includeAll: true });
}
function symbolQuery(req) {
  const file = String(req.query.file || "");
  const symbol = String(req.query.symbol || "");
  if (!file || file.length > 1024 || !symbol || symbol.length > 120 || !/^[A-Za-z_$][\\w$]*$/.test(symbol)) return null;
  return { file, symbol, line: Math.max(1, Number.parseInt(req.query.line, 10) || 1) };
}
router.get("/symbols/definition", async (req, res) => {
  const query = symbolQuery(req);
  if (!query) return res.status(400).json({ error: "InvalidSymbolQuery" });
  try {
    const workspace = getWorkspaceService(req.workspaceAccess?.ownerUserId || req.user.id, req.workspaceAccess?.workspaceId || req.get("X-Workspace-Id") || "default");
    const target = workspace.resolvePath(query.file);
    if (!target.safe) return res.status(403).json({ error: "Forbidden" });
    const index = await symbolIndexForRequest(req);
    const matches = (index.declarations || []).filter(item => item.name === query.symbol);
    if (!matches.length) return res.json({ symbol: query.symbol, definition: null, parsedFileCount: index.parsedFileCount });
    matches.sort((a, b) => (a.path === target.relative ? 0 : 1) - (b.path === target.relative ? 0 : 1) || Math.abs(a.startLine - query.line) - Math.abs(b.startLine - query.line) || a.path.localeCompare(b.path));
    const item = matches[0];
    return res.json({ symbol: query.symbol, definition: { file: item.path, line: item.startLine, col: item.column || 1, kind: item.kind, signature: item.signature || item.name } });
  } catch {
    return res.status(503).json({ error: "SymbolIndexUnavailable", message: "The workspace symbol index could not be built." });
  }
});
router.get("/symbols/hover", async (req, res) => {
  const query = symbolQuery(req);
  if (!query) return res.status(400).json({ error: "InvalidSymbolQuery" });
  try {
    const workspace = getWorkspaceService(req.workspaceAccess?.ownerUserId || req.user.id, req.workspaceAccess?.workspaceId || req.get("X-Workspace-Id") || "default");
    const target = workspace.resolvePath(query.file);
    if (!target.safe) return res.status(403).json({ error: "Forbidden" });
    const index = await symbolIndexForRequest(req);
    const matches = (index.declarations || []).filter(item => item.name === query.symbol);
    if (!matches.length) return res.json({ hover: null });
    matches.sort((a, b) => (a.path === target.relative ? 0 : 1) - (b.path === target.relative ? 0 : 1) || Math.abs(a.startLine - query.line) - Math.abs(b.startLine - query.line));
    const item = matches[0];
    return res.json({ hover: { name: item.name, kind: item.kind, file: item.path, line: item.startLine, signature: item.signature || item.name } });
  } catch {
    return res.status(503).json({ error: "SymbolIndexUnavailable", message: "The workspace symbol index could not be built." });
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
