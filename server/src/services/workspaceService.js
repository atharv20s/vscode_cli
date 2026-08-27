/**
 * Workspace Service & Native File Watcher
 * 
 * Central controller for all workspace file mutations, path sandboxing policies,
 * directory tree indexing, and native filesystem watching for external change detection.
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import { eventBus, EVENT_TOPICS } from "../websocket/eventBus.js";

/** Ignored directories for watching and listing */
const IGNORED_DIRS = new Set(["node_modules", ".git", ".worktrees", "dist", "build", ".next", ".cache"]);

class WorkspaceService {
  constructor() {
    this.workspaceRoot = path.resolve(config.workspaceRoot);
    this.watcher = null;
    this._recentInternalMutations = new Map(); // path -> timestamp
    this._initWatcher();
  }

  /**
   * Validate and resolve safe workspace paths.
   * 
   * @param {string} targetPath - Relative or absolute path
   * @returns {{ safe: boolean, resolved: string, relative: string }}
   */
  resolvePath(targetPath) {
    if (!targetPath) {
      return { safe: true, resolved: this.workspaceRoot, relative: "." };
    }

    const resolved = path.resolve(this.workspaceRoot, targetPath);
    const safe = resolved.startsWith(this.workspaceRoot);
    const relative = path.relative(this.workspaceRoot, resolved).replace(/\\/g, "/") || ".";

    return { safe, resolved, relative };
  }

  /**
   * Read file content with optional line slicing.
   */
  async readFile(filePath, startLine = null, endLine = null) {
    const { safe, resolved, relative } = this.resolvePath(filePath);
    if (!safe) throw new Error(`Access denied: Path is outside workspace root (${filePath})`);

    const content = await fsp.readFile(resolved, "utf8");

    if (startLine || endLine) {
      const lines = content.split("\n");
      const start = Math.max(1, startLine || 1) - 1;
      const end = Math.min(lines.length, endLine || lines.length);
      const slice = lines.slice(start, end);
      return {
        path: relative,
        content: slice.map((line, i) => `${start + i + 1}: ${line}`).join("\n"),
        rawSlice: slice.join("\n"),
        totalLines: lines.length,
      };
    }

    return {
      path: relative,
      content,
      size: Buffer.byteLength(content),
    };
  }

  /**
   * Write or overwrite a file.
   */
  async writeFile(filePath, content, options = {}) {
    const { safe, resolved, relative } = this.resolvePath(filePath);
    if (!safe) throw new Error(`Access denied: Path is outside workspace root (${filePath})`);

    const isNew = !fs.existsSync(resolved);
    await fsp.mkdir(path.dirname(resolved), { recursive: true });
    await fsp.writeFile(resolved, content, "utf8");

    this._recordInternalMutation(relative);

    const eventType = isNew ? EVENT_TOPICS.FILE_CREATED : EVENT_TOPICS.FILE_CHANGED;
    eventBus.publish(eventType, {
      path: relative,
      operation: isNew ? "create" : "modify",
      version: Date.now(),
      size: Buffer.byteLength(content),
    }, {
      source: options.source || "fs",
      actor: options.actor || "user",
      turnId: options.turnId || null,
      operationId: options.operationId || null,
    });

    return { success: true, path: relative, isNew, size: Buffer.byteLength(content) };
  }

  /**
   * Delete a file from the workspace.
   */
  async deleteFile(filePath, options = {}) {
    const { safe, resolved, relative } = this.resolvePath(filePath);
    if (!safe) throw new Error(`Access denied: Path is outside workspace root (${filePath})`);

    await fsp.rm(resolved, { recursive: true, force: true });
    this._recordInternalMutation(relative);

    eventBus.publish(EVENT_TOPICS.FILE_DELETED, {
      path: relative,
      operation: "delete",
      version: Date.now(),
    }, {
      source: options.source || "fs",
      actor: options.actor || "user",
    });

    return { success: true, path: relative };
  }

  /**
   * Rename or move a file.
   */
  async renameFile(fromPath, toPath, options = {}) {
    const from = this.resolvePath(fromPath);
    const to = this.resolvePath(toPath);

    if (!from.safe || !to.safe) {
      throw new Error("Access denied: Paths must reside within the workspace root.");
    }

    await fsp.mkdir(path.dirname(to.resolved), { recursive: true });
    await fsp.rename(from.resolved, to.resolved);

    this._recordInternalMutation(from.relative);
    this._recordInternalMutation(to.relative);

    eventBus.publish(EVENT_TOPICS.FILE_RENAMED, {
      from: from.relative,
      to: to.relative,
      path: to.relative,
      operation: "rename",
      version: Date.now(),
    }, {
      source: options.source || "fs",
      actor: options.actor || "user",
    });

    return { success: true, from: from.relative, to: to.relative };
  }

  /**
   * Create a directory.
   */
  async createDirectory(dirPath) {
    const { safe, resolved, relative } = this.resolvePath(dirPath);
    if (!safe) throw new Error(`Access denied: Path is outside workspace root (${dirPath})`);

    await fsp.mkdir(resolved, { recursive: true });
    return { success: true, path: relative };
  }

  /**
   * List directory entries with metadata.
   */
  async listDirectory(dirPath = ".") {
    const { safe, resolved, relative } = this.resolvePath(dirPath);
    if (!safe) throw new Error(`Access denied: Path is outside workspace root (${dirPath})`);

    await fsp.mkdir(resolved, { recursive: true });
    const entries = await fsp.readdir(resolved, { withFileTypes: true });

    const items = await Promise.all(
      entries
        .filter((e) => !e.name.startsWith(".") && !IGNORED_DIRS.has(e.name))
        .map(async (entry) => {
          const entryPath = path.join(resolved, entry.name);
          const isDir = entry.isDirectory();
          let size = 0;
          if (!isDir) {
            try {
              const stat = await fsp.stat(entryPath);
              size = stat.size;
            } catch {}
          }
          return {
            name: entry.name,
            isDirectory: isDir,
            size,
            path: path.relative(this.workspaceRoot, entryPath).replace(/\\/g, "/"),
          };
        })
    );

    return { path: relative, entries: items };
  }

  /**
   * Record internal mutation to deduplicate external watcher events.
   * @private
   */
  _recordInternalMutation(relativePath) {
    this._recentInternalMutations.set(relativePath, Date.now());
    setTimeout(() => {
      this._recentInternalMutations.delete(relativePath);
    }, 2000);
  }

  /**
   * Native file watcher setup with debouncing.
   * @private
   */
  _initWatcher() {
    try {
      if (!fs.existsSync(this.workspaceRoot)) {
        try {
          fs.mkdirSync(this.workspaceRoot, { recursive: true });
        } catch (e) {
          const fallback = path.resolve(process.cwd(), "workspace");
          logger.warn(`WorkspaceService: Could not access '${this.workspaceRoot}' (${e.message}). Falling back to '${fallback}'`);
          this.workspaceRoot = fallback;
          if (!fs.existsSync(this.workspaceRoot)) {
            fs.mkdirSync(this.workspaceRoot, { recursive: true });
          }
        }
      }

      let debounceTimer = null;
      const pendingChanges = new Set();

      this.watcher = fs.watch(this.workspaceRoot, { recursive: true }, (eventType, filename) => {
        if (!filename) return;

        const normalized = filename.replace(/\\/g, "/");
        const parts = normalized.split("/");
        if (parts.some((p) => IGNORED_DIRS.has(p) || p.startsWith("."))) {
          return;
        }

        // Ignore if we just mutated it internally
        if (this._recentInternalMutations.has(normalized)) {
          return;
        }

        pendingChanges.add(normalized);

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          for (const changedPath of pendingChanges) {
            const fullPath = path.join(this.workspaceRoot, changedPath);
            const exists = fs.existsSync(fullPath);

            const topic = exists ? EVENT_TOPICS.FILE_CHANGED : EVENT_TOPICS.FILE_DELETED;
            eventBus.publish(topic, {
              path: changedPath,
              operation: exists ? "external_modify" : "external_delete",
              version: Date.now(),
            }, {
              source: "watcher",
              actor: "user",
            });

            logger.debug(`WorkspaceService: Watcher detected external change -> ${changedPath}`);
          }
          pendingChanges.clear();
        }, 300);
      });

      logger.info(`WorkspaceService: Native file watcher initialized on ${this.workspaceRoot}`);
    } catch (err) {
      logger.warn(`WorkspaceService: File watcher initialization notice: ${err.message}`);
    }
  }
}

export const workspaceService = new WorkspaceService();
