/**
 * File Controller — Workspace file operations via REST.
 */

import { getWorkspaceService } from "../services/workspaceService.js";
import { config } from "../config/env.js";
import { pullWorkspaceFromRemote, syncWorkspaceOnRemote } from "../services/remoteExecutionWorker.js";

function workspaceForRequest(req) {
  return getWorkspaceService(req.workspaceAccess?.ownerUserId || req.user.id, req.workspaceAccess?.workspaceId || req.get("X-Workspace-Id") || "default");
}

async function pullRuntimeChanges(workspaceService) {
  if (config.executionRuntime !== "remote") return;
  await pullWorkspaceFromRemote({ workspaceId: workspaceService.workspaceId, workspaceDir: workspaceService.workspaceRoot });
}

async function pushRuntimeChanges(workspaceService) {
  if (config.executionRuntime !== "remote") return true;
  try {
    await syncWorkspaceOnRemote({ workspaceId: workspaceService.workspaceId, workspaceDir: workspaceService.workspaceRoot });
    return true;
  } catch {
    return false;
  }
}

/**
 * GET /api/workspace/files?path=.
 */
export async function listFiles(req, res) {
  const workspaceService = workspaceForRequest(req);
  const dirPath = req.query.path || ".";
  try {
    await pullRuntimeChanges(workspaceService);
    const data = await workspaceService.listDirectory(dirPath);
    res.json(data);
  } catch (err) {
    if (err.message?.includes("Access denied")) {
      return res.status(403).json({ error: "Forbidden", message: err.message });
    }
    if (err.code === "ENOENT") {
      return res.status(404).json({ error: "NotFound", message: `Directory not found: ${dirPath}` });
    }
    res.status(500).json({ error: "InternalError", message: err.message });
  }
}

/**
 * GET /api/workspace/file?path=src/main.js
 */
export async function readFile(req, res) {
  const workspaceService = workspaceForRequest(req);
  const filePath = req.query.path;
  if (!filePath) {
    return res.status(400).json({ error: "BadRequest", message: "Missing 'path' query parameter" });
  }

  try {
    await pullRuntimeChanges(workspaceService);
    const result = await workspaceService.readFile(filePath);
    if (result.version) res.setHeader("ETag", '"' + result.version + '"');
    res.json({ path: result.path, content: result.content, size: Buffer.byteLength(result.content), version: result.version });
  } catch (err) {
    if (err.message?.includes("Access denied")) {
      return res.status(403).json({ error: "Forbidden", message: err.message });
    }
    if (err.code === "ENOENT") {
      return res.status(404).json({ error: "NotFound", message: `File not found: ${filePath}` });
    }
    res.status(500).json({ error: "InternalError", message: err.message });
  }
}

/**
 * POST /api/workspace/file { path, content }
 */
export async function writeFile(req, res) {
  const workspaceService = getWorkspaceService(req.user.id, req.get("X-Workspace-Id") || "default");
  const { path: filePath, content } = req.body;
  if (!filePath || content === undefined) {
    return res.status(400).json({ error: "BadRequest", message: "Missing 'path' or 'content'" });
  }

  try {
    const ifMatch = req.get("If-Match");
    const ifNoneMatch = req.get("If-None-Match");
    const expectedVersion = ifMatch ? ifMatch.replace(/^W\//, "").replace(/^"|"$/g, "") : undefined;
    const result = await workspaceService.writeFile(filePath, content, {
      expectedVersion,
      mustNotExist: ifNoneMatch === "*",
      source: "ui",
      actor: req.user.id,
    });
    const runtimeSynced = await pushRuntimeChanges(workspaceService);
    res.setHeader("ETag", '"' + result.version + '"');
    res.json({ success: true, path: result.path, size: Buffer.byteLength(content), version: result.version, isNew: result.isNew, runtimeSynced });
  } catch (err) {
    if (err.message?.includes("Access denied")) return res.status(403).json({ error: "Forbidden", message: err.message });
    if (err.code === "WORKSPACE_VERSION_CONFLICT") return res.status(409).json({ error: "WorkspaceConflict", message: err.message, currentVersion: err.currentVersion || null });
    if (err.code === "WORKSPACE_QUOTA_EXCEEDED" || err.code === "WORKSPACE_FILE_TOO_LARGE") return res.status(413).json({ error: err.code, message: err.message });
    if (err.code === "WORKSPACE_BUSY") return res.status(423).json({ error: "WorkspaceBusy", message: err.message });
    res.status(500).json({ error: "InternalError", message: err.message });
  }
}

/**
 * DELETE /api/workspace/file?path=old-file.txt
 */
export async function deleteFile(req, res) {
  const workspaceService = getWorkspaceService(req.user.id, req.get("X-Workspace-Id") || "default");
  const filePath = req.query.path;
  if (!filePath) {
    return res.status(400).json({ error: "BadRequest", message: "Missing 'path' query parameter" });
  }

  try {
    const result = await workspaceService.deleteFile(filePath);
    const runtimeSynced = await pushRuntimeChanges(workspaceService);
    res.json({ success: true, path: result.path, runtimeSynced });
  } catch (err) {
    if (err.message?.includes("Access denied")) {
      return res.status(403).json({ error: "Forbidden", message: err.message });
    }
    if (err.code === "ENOENT") {
      return res.status(404).json({ error: "NotFound", message: `File not found: ${filePath}` });
    }
    res.status(500).json({ error: "InternalError", message: err.message });
  }
}

/**
 * POST /api/workspace/move { from, to }
 */
export async function moveFile(req, res) {
  const workspaceService = getWorkspaceService(req.user.id, req.get("X-Workspace-Id") || "default");
  const { from, to } = req.body;
  if (!from || !to) {
    return res.status(400).json({ error: "BadRequest", message: "Missing 'from' or 'to' path" });
  }

  try {
    const result = await workspaceService.renameFile(from, to);
    const runtimeSynced = await pushRuntimeChanges(workspaceService);
    res.json({ success: true, from: result.from, to: result.to, runtimeSynced });
  } catch (err) {
    if (err.message?.includes("Access denied")) return res.status(403).json({ error: "Forbidden", message: err.message });
    res.status(500).json({ error: "InternalError", message: err.message });
  }
}

/**
 * POST /api/workspace/folder { path }
 */
export async function createFolder(req, res) {
  const workspaceService = getWorkspaceService(req.user.id, req.get("X-Workspace-Id") || "default");
  const { path: folderPath } = req.body;
  if (!folderPath) {
    return res.status(400).json({ error: "BadRequest", message: "Missing folder path" });
  }

  try {
    const result = await workspaceService.createDirectory(folderPath);
    const runtimeSynced = await pushRuntimeChanges(workspaceService);
    res.json({ success: true, path: result.path, runtimeSynced });
  } catch (err) {
    if (err.message?.includes("Access denied")) return res.status(403).json({ error: "Forbidden", message: err.message });
    res.status(500).json({ error: "InternalError", message: err.message });
  }
}

/**
 * POST /api/workspace/exec — Execute shell command via ExecutionService in workspace.
 */
export async function execCommand(req, res) {
  const workspaceService = getWorkspaceService(req.user.id, req.get("X-Workspace-Id") || "default");
  const { command, shell = "powershell" } = req.body;
  if (!command || typeof command !== "string") {
    return res.status(400).json({ error: "BadRequest", message: "Missing 'command' in request body" });
  }

  try {
    const { executionService } = await import("../services/executionService.js");
    const result = await executionService.execute({
      command,
      shell,
      cwd: workspaceService.workspaceRoot,
      workspaceId: workspaceService.workspaceId,
      workspaceDir: workspaceService.workspaceRoot,
      mode: "AGENT_BACKGROUND",
    });

    res.json({
      success: result.success,
      shellUsed: shell,
      output: result.output,
      exitCode: result.exitCode,
    });
  } catch (err) {
    res.status(500).json({ error: "InternalError", message: err.message });
  }
}
