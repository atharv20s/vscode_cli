/**
 * File Controller — Workspace file operations via REST.
 */

import fs from "fs/promises";
import path from "path";
import { config } from "../config/env.js";

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
    res.json({ success: true, path: folderPath });
  } catch (err) {
    res.status(500).json({ error: "InternalError", message: err.message });
  }
}

/**
 * POST /api/workspace/exec — Execute shell command in workspace directly.
 * Body: { command, shell }
 */
export async function execCommand(req, res) {
  const { command, shell = "powershell" } = req.body;
  if (!command || typeof command !== "string") {
    return res.status(400).json({ error: "BadRequest", message: "Missing command string" });
  }

  const { exec } = await import("child_process");
  const isWindows = process.platform === "win32";

  let finalCmd = command;
  let execOptions = { cwd: config.workspaceRoot, timeout: 30000 };

  if (shell === "wsl" && isWindows) {
    // Format path for WSL
    const winPath = config.workspaceRoot.replace(/\\/g, "/");
    const driveMatch = winPath.match(/^([A-Za-z]):\/(.*)/);
    const wslPath = driveMatch ? `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2]}` : winPath;
    const escaped = command.replace(/"/g, '\\"');
    finalCmd = `wsl.exe --cd "${wslPath}" -e bash -c "${escaped}"`;
  } else if (shell === "cmd" && isWindows) {
    finalCmd = `cmd.exe /c "${command}"`;
  } else if (shell === "powershell" && isWindows) {
    finalCmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${command.replace(/"/g, '`"')}"`;
  }

  exec(finalCmd, execOptions, (error, stdout, stderr) => {
    res.json({
      success: !error,
      shellUsed: shell,
      output: (stdout || stderr || (error ? error.message : "Command finished.")).trim(),
      exitCode: error ? error.code || 1 : 0,
    });
  });
}
