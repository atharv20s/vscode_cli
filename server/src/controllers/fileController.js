/**
 * File Controller — Workspace file operations via REST.
 */

import fs from "fs/promises";
import path from "path";
import { config } from "../config/env.js";
import { eventBus } from "../websocket/eventBus.js";

/**
 * Resolve path safely within workspace.
 */
function safePath(filePath) {
  const resolved = path.resolve(config.workspaceRoot, filePath);
  if (!resolved.startsWith(path.resolve(config.workspaceRoot))) {
    return null;
  }
  return resolved;
}

/**
 * GET /api/workspace/files?path=.
 */
export async function listFiles(req, res) {
  const dirPath = req.query.path || ".";
  const resolved = safePath(dirPath);
  if (!resolved) {
    return res.status(403).json({ error: "Forbidden", message: "Path outside workspace" });
  }

  try {
    await fs.mkdir(resolved, { recursive: true });
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const items = await Promise.all(
      entries
        .filter((e) => !e.name.startsWith("."))
        .map(async (entry) => {
          const entryPath = path.join(resolved, entry.name);
          const isDir = entry.isDirectory();
          let size = 0;
          if (!isDir) {
            try {
              const stat = await fs.stat(entryPath);
              size = stat.size;
            } catch {}
          }
          return {
            name: entry.name,
            isDirectory: isDir,
            size,
            path: path.relative(config.workspaceRoot, entryPath).replace(/\\/g, "/"),
          };
        })
    );

    res.json({ path: dirPath, entries: items });
  } catch (err) {
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
  const filePath = req.query.path;
  if (!filePath) {
    return res.status(400).json({ error: "BadRequest", message: "Missing 'path' query parameter" });
  }

  const resolved = safePath(filePath);
  if (!resolved) {
    return res.status(403).json({ error: "Forbidden", message: "Path outside workspace" });
  }

  try {
    const content = await fs.readFile(resolved, "utf8");
    res.json({ path: filePath, content, size: Buffer.byteLength(content) });
  } catch (err) {
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
  const { path: filePath, content } = req.body;
  if (!filePath || content === undefined) {
    return res.status(400).json({ error: "BadRequest", message: "Missing 'path' or 'content'" });
  }

  const resolved = safePath(filePath);
  if (!resolved) {
    return res.status(403).json({ error: "Forbidden", message: "Path outside workspace" });
  }

  try {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf8");

    // Emit lightweight metadata-only event
    eventBus.publish("file.changed", {
      path: filePath,
      operation: "modify",
      version: Date.now(),
    }, {
      source: "fs",
      actor: "user",
    });

    res.json({ success: true, path: filePath, size: Buffer.byteLength(content) });
  } catch (err) {
    res.status(500).json({ error: "InternalError", message: err.message });
  }
}

/**
 * DELETE /api/workspace/file?path=old-file.txt
 */
export async function deleteFile(req, res) {
  const filePath = req.query.path;
  if (!filePath) {
    return res.status(400).json({ error: "BadRequest", message: "Missing 'path' query parameter" });
  }

  const resolved = safePath(filePath);
  if (!resolved) {
    return res.status(403).json({ error: "Forbidden", message: "Path outside workspace" });
  }

  try {
    await fs.rm(resolved, { recursive: true, force: true });

    eventBus.publish("file.changed", {
      path: filePath,
      operation: "delete",
      version: Date.now(),
    }, {
      source: "fs",
      actor: "user",
    });

    res.json({ success: true, path: filePath });
  } catch (err) {
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
  const { from, to } = req.body;
  if (!from || !to) {
    return res.status(400).json({ error: "BadRequest", message: "Missing 'from' or 'to' path" });
  }

  const resolvedFrom = safePath(from);
  const resolvedTo = safePath(to);
  if (!resolvedFrom || !resolvedTo) {
    return res.status(403).json({ error: "Forbidden", message: "Path outside workspace" });
  }

  try {
    await fs.mkdir(path.dirname(resolvedTo), { recursive: true });
    await fs.rename(resolvedFrom, resolvedTo);

    eventBus.publish("file.changed", {
      from,
      to,
      path: to,
      operation: "move",
      version: Date.now(),
    }, {
      source: "fs",
      actor: "user",
    });

    res.json({ success: true, from, to });
  } catch (err) {
    res.status(500).json({ error: "InternalError", message: err.message });
  }
}

/**
 * POST /api/workspace/folder { path }
 */
export async function createFolder(req, res) {
  const { path: folderPath } = req.body;
  if (!folderPath) {
    return res.status(400).json({ error: "BadRequest", message: "Missing folder path" });
  }

  const resolved = safePath(folderPath);
  if (!resolved) {
    return res.status(403).json({ error: "Forbidden", message: "Path outside workspace" });
  }

  try {
    await fs.mkdir(resolved, { recursive: true });

    eventBus.publish("file.changed", {
      path: folderPath,
      operation: "create_folder",
      version: Date.now(),
    }, {
      source: "fs",
      actor: "user",
    });

    res.json({ success: true, path: folderPath });
  } catch (err) {
    res.status(500).json({ error: "InternalError", message: err.message });
  }
}

/**
 * POST /api/workspace/exec — Execute shell command via ExecutionService in workspace.
 */
export async function execCommand(req, res) {
  const { command, shell = "powershell" } = req.body;
  if (!command || typeof command !== "string") {
    return res.status(400).json({ error: "BadRequest", message: "Missing 'command' in request body" });
  }

  try {
    const { executionService } = await import("../services/executionService.js");
    const result = await executionService.execute({
      command,
      shell,
      cwd: config.workspaceRoot,
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
