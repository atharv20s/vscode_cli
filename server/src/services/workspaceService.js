/**
 * Workspace Service & Native File Watcher
 * 
 * Central controller for all workspace file mutations, path sandboxing policies,
 * directory tree indexing, and native filesystem watching for external change detection.
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import { eventBus, EVENT_TOPICS } from "../websocket/eventBus.js";

/** Ignored directories for watching and listing */
const IGNORED_DIRS = new Set(["node_modules", ".git", ".worktrees", "dist", "build", ".next", ".cache"]);

export class WorkspaceService {
  constructor(root = config.workspaceRoot, workspaceId = "system", options = {}) {
    this.workspaceRoot = path.resolve(root);
    this.workspaceId = workspaceId;
    this.quotaRoot = options.quotaRoot || this.workspaceRoot;
    this.lockRoot = options.lockRoot || path.join(this.quotaRoot, ".ath-locks");
    this.watcher = null;
    this._recentInternalMutations = new Map(); // path -> timestamp
    if (options.watch !== false) this._initWatcher();
  }

  /**
   * Validate and resolve safe workspace paths.
   * 
   * @param {string} targetPath - Relative or absolute path
   * @returns {{ safe: boolean, resolved: string, relative: string }}
   */
  resolvePath(targetPath) {
    const resolved = path.resolve(this.workspaceRoot, targetPath || ".");
    const relativePath = path.relative(this.workspaceRoot, resolved);
    const insideRoot =
      relativePath === "" ||
      (relativePath !== ".." &&
        !relativePath.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativePath));

    if (!insideRoot) {
      return {
        safe: false,
        resolved,
        relative: relativePath.split(path.sep).join("/"),
      };
    }

    // Internal locking metadata is not part of the user workspace API.
    if (relativePath.split(path.sep).some((part) => part === ".ath-locks" || part === ".ath-workspaces.json")) {
      return { safe: false, resolved, relative: relativePath.split(path.sep).join("/") };
    }

    // Repository task agents must never inspect or mutate Git's control data.
    if (this.workspaceId.startsWith("repo-agent-") &&
        relativePath.split(path.sep).some((part) => part.toLowerCase() === ".git")) {
      return { safe: false, resolved, relative: relativePath.split(path.sep).join("/") };
    }

    // Resolve the deepest existing ancestor so symlinks cannot redirect a
    // missing/new target outside the workspace. realpathSync also canonicalizes
    // the workspace root and existing target before the containment check.
    try {
      const realRoot = fs.realpathSync(this.workspaceRoot);
      let existingAncestor = resolved;
      const missingSegments = [];

      while (!fs.existsSync(existingAncestor)) {
        const parent = path.dirname(existingAncestor);
        if (parent === existingAncestor) {
          return { safe: false, resolved, relative: relativePath };
        }
        missingSegments.unshift(path.basename(existingAncestor));
        existingAncestor = parent;
      }

      const realAncestor = fs.realpathSync(existingAncestor);
      const canonicalTarget = path.join(realAncestor, ...missingSegments);
      const canonicalRelative = path.relative(realRoot, canonicalTarget);
      if (this.workspaceId.startsWith("repo-agent-") &&
          canonicalRelative.split(path.sep).some((part) => part.toLowerCase() === ".git")) {
        return { safe: false, resolved, relative: relativePath.split(path.sep).join("/") };
      }
      const canonicalInsideRoot =
        canonicalRelative === "" ||
        (canonicalRelative !== ".." &&
          !canonicalRelative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(canonicalRelative));

      return {
        safe: canonicalInsideRoot,
        resolved,
        relative: relativePath.split(path.sep).join("/") || ".",
      };
    } catch (error) {
      // Fail closed on unexpected filesystem errors. A missing path below a
      // valid existing ancestor is handled above; permission and I/O errors
      // must not silently authorize access.
      return { safe: false, resolved, relative: relativePath };
    }
  }

  async _withQuotaLock(callback) {
    await fsp.mkdir(this.lockRoot, { recursive: true, mode: 0o700 });
    const lockPath = path.join(this.lockRoot, "workspace-write.lock");
    const started = Date.now();
    let handle = null;
    while (!handle) {
      try {
        handle = await fsp.open(lockPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          const stat = await fsp.stat(lockPath);
          if (Date.now() - stat.mtimeMs > 300000) {
            await fsp.unlink(lockPath).catch(() => {});
            continue;
          }
        } catch (statError) {
          if (statError.code === "ENOENT") continue;
          throw statError;
        }
        if (Date.now() - started > 10000) {
          const busy = new Error("Workspace is busy with another save. Retry shortly.");
          busy.code = "WORKSPACE_BUSY";
          throw busy;
        }
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    }
    const heartbeat = setInterval(() => {
      const now = new Date();
      fsp.utimes(lockPath, now, now).catch(() => {});
    }, 10000);
    heartbeat.unref?.();
    try { return await callback(); }
    finally {
      clearInterval(heartbeat);
      await handle.close().catch(() => {});
      await fsp.unlink(lockPath).catch(() => {});
    }
  }

  async _measureWorkspaceBytes(root = this.quotaRoot) {
    let total = 0;
    const stack = [root];
    while (stack.length) {
      const current = stack.pop();
      let entries = [];
      try { entries = await fsp.readdir(current, { withFileTypes: true }); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      for (const entry of entries) {
        if (entry.name === ".ath-locks" || entry.name === ".ath-workspaces.json") continue;
        const target = path.join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) stack.push(target);
        else if (entry.isFile()) {
          const stat = await fsp.stat(target);
          total += stat.size;
        }
      }
    }
    return total;
  }

  _version(content) {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  /**
   * Read file content with optional line slicing.
   */
  async readFile(filePath, startLine = null, endLine = null) {
    const { safe, resolved, relative } = this.resolvePath(filePath);
    if (!safe) throw new Error(`Access denied: Path is outside workspace root (${filePath})`);

    const content = await fsp.readFile(resolved, "utf8");
    const version = this._version(content);

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
        version,
      };
    }

    return {
      path: relative,
      content,
      size: Buffer.byteLength(content),
      version,
    };
  }

  /**
   * Write or overwrite a file.
   */
  async writeFile(filePath, content, options = {}) {
    const { safe, resolved, relative } = this.resolvePath(filePath);
    if (!safe) throw new Error("Access denied: Path is outside workspace root (" + filePath + ")");
    if (typeof content !== "string") throw new TypeError("Workspace files must be UTF-8 text.");
    const bytes = Buffer.byteLength(content);
    if (bytes > config.workspaceMaxFileBytes) {
      const error = new Error("File exceeds the " + config.workspaceMaxFileBytes + " byte per-file limit.");
      error.code = "WORKSPACE_FILE_TOO_LARGE";
      throw error;
    }

    return this._withQuotaLock(async () => {
      let current = null;
      try { current = await fsp.readFile(resolved, "utf8"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const currentVersion = current === null ? null : this._version(current);
      if (options.expectedVersion !== undefined && options.expectedVersion !== currentVersion) {
        const error = new Error("This file changed in another session. Reload it before saving.");
        error.code = "WORKSPACE_VERSION_CONFLICT";
        error.currentVersion = currentVersion;
        throw error;
      }
      if (options.mustNotExist && current !== null) {
        const error = new Error("A file with this path already exists.");
        error.code = "WORKSPACE_VERSION_CONFLICT";
        error.currentVersion = currentVersion;
        throw error;
      }

      const used = await this._measureWorkspaceBytes();
      const previousSize = current === null ? 0 : Buffer.byteLength(current);
      if (used - previousSize + bytes > config.workspaceQuotaBytes) {
        const error = new Error("Workspace storage quota exceeded (" + config.workspaceQuotaBytes + " bytes).");
        error.code = "WORKSPACE_QUOTA_EXCEEDED";
        throw error;
      }

      await fsp.mkdir(path.dirname(resolved), { recursive: true });
      const temporary = path.join(path.dirname(resolved), "." + path.basename(resolved) + "." + process.pid + "." + crypto.randomBytes(6).toString("hex") + ".tmp");
      try {
        await fsp.writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await fsp.rename(temporary, resolved);
      } finally {
        await fsp.unlink(temporary).catch(() => {});
      }
      this._alignRuntimeOwnership(resolved);
      this._recordInternalMutation(relative);
      const isNew = current === null;
      const version = this._version(content);
      eventBus.publish(isNew ? EVENT_TOPICS.FILE_CREATED : EVENT_TOPICS.FILE_CHANGED, {
        path: relative,
        operation: isNew ? "create" : "modify",
        version: Date.now(),
        contentVersion: version,
        size: bytes,
      }, {
        workspaceId: this.workspaceId,
        source: options.source || "fs",
        actor: options.actor || "user",
        turnId: options.turnId || null,
        operationId: options.operationId || null,
      });
      return { success: true, path: relative, isNew, size: bytes, version };
    });
  }

  /**
   * Delete a file from the workspace.
   */
  async deleteFile(filePath, options = {}) {
    const { safe, resolved, relative } = this.resolvePath(filePath);
    if (!safe) throw new Error("Access denied: Path is outside workspace root (" + filePath + ")");
    return this._withQuotaLock(async () => {
      if (options.expectedVersion !== undefined) {
        let current = null;
        try { current = await fsp.readFile(resolved, "utf8"); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        const version = current === null ? null : this._version(current);
        if (version !== options.expectedVersion) {
          const error = new Error("This file changed in another session. Reload it before deleting.");
          error.code = "WORKSPACE_VERSION_CONFLICT";
          throw error;
        }
      }
      await fsp.rm(resolved, { recursive: true, force: true });
      this._recordInternalMutation(relative);
      eventBus.publish(EVENT_TOPICS.FILE_DELETED, {
        path: relative,
        operation: "delete",
        version: Date.now(),
      }, {
        workspaceId: this.workspaceId,
        source: options.source || "fs",
        actor: options.actor || "user",
      });
      return { success: true, path: relative };
    });
  }

  /**
   * Rename or move a file.
   */
  async renameFile(fromPath, toPath, options = {}) {
    return this._withQuotaLock(async () => {
    const from = this.resolvePath(fromPath);
    const to = this.resolvePath(toPath);

    if (!from.safe || !to.safe) {
      throw new Error("Access denied: Paths must reside within the workspace root.");
    }

    if (fs.existsSync(to.resolved)) {
      const error = new Error("Destination already exists. Choose a different path.");
      error.code = "WORKSPACE_VERSION_CONFLICT";
      throw error;
    }
    await fsp.mkdir(path.dirname(to.resolved), { recursive: true });
    await fsp.rename(from.resolved, to.resolved);
    this._alignRuntimeOwnership(to.resolved);

    this._recordInternalMutation(from.relative);
    this._recordInternalMutation(to.relative);

    eventBus.publish(EVENT_TOPICS.FILE_RENAMED, {
      from: from.relative,
      to: to.relative,
      path: to.relative,
      operation: "rename",
      version: Date.now(),
    }, {
      workspaceId: this.workspaceId,
      source: options.source || "fs",
      actor: options.actor || "user",
    });

    return { success: true, from: from.relative, to: to.relative };
    });
  }

  /**
   * Create a directory.
   */
  async createDirectory(dirPath) {
    const { safe, resolved, relative } = this.resolvePath(dirPath);
    if (!safe) throw new Error(`Access denied: Path is outside workspace root (${dirPath})`);

    await fsp.mkdir(resolved, { recursive: true });
    this._alignRuntimeOwnership(resolved);
    return { success: true, path: relative };
  }

  /**
   * List directory entries with metadata.
   */
  async listDirectory(dirPath = ".") {
    const { safe, resolved, relative } = this.resolvePath(dirPath);
    if (!safe) throw new Error(`Access denied: Path is outside workspace root (${dirPath})`);

    await fsp.mkdir(resolved, { recursive: true });
    this._alignRuntimeOwnership(resolved);
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
   * Keep host-created workspace files writable by the configured container UID.
   * Ownership changes are limited to the current private workspace.
   */
  _alignRuntimeOwnership(targetPath) {
    if (config.executionRuntime !== "docker") return;
    // Docker Desktop on Windows mediates bind-mount permissions through ACLs.
    if (process.platform === "win32" || typeof fs.chownSync !== "function") return;
    const uid = config.dockerWorkspaceUid;
    const gid = config.dockerWorkspaceGid;
    let current = targetPath;
    while (current === this.workspaceRoot || current.startsWith(this.workspaceRoot + path.sep)) {
      fs.chownSync(current, uid, gid);
      if (current === this.workspaceRoot) break;
      current = path.dirname(current);
    }
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
              workspaceId: this.workspaceId,
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

const workspaceServices = new Map();

/**
 * Return a filesystem service rooted in a private, stable directory for one
 * authenticated user. The opaque directory name prevents usernames/IDs from
 * becoming path components and avoids traversal through crafted identities.
 */
/**
 * Create a disposable, task-scoped workspace rooted at an application-generated
 * directory. Callers must never pass a user-controlled filesystem path here.
 */
export function createScopedWorkspaceService(root, workspaceId) {
  if (typeof root !== "string" || !path.isAbsolute(root) || !workspaceId) {
    throw new Error("A task workspace requires an absolute root and workspace ID.");
  }
  const resolvedRoot = path.resolve(root);
  fs.mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
  return new WorkspaceService(resolvedRoot, String(workspaceId), { watch: false });
}

/**
 * Resolve the workspace service for an agent tool call. A task-scoped service
 * takes precedence over the user's general workspace, preventing repository
 * tasks from reading or editing sibling user projects.
 */
export function getWorkspaceServiceForContext(ctx = {}) {
  if (ctx.workspaceService) return ctx.workspaceService;
  return getWorkspaceService(ctx.userId || ctx.workspaceId);
}

export function getWorkspaceService(userId, workspaceKey = "default") {
  if (typeof userId !== "string" || !userId.trim()) throw new Error("An authenticated workspace owner is required.");
  if (typeof workspaceKey !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(workspaceKey)) throw new Error("Invalid workspace identifier.");
  const ownerKey = crypto.createHash("sha256").update(userId).digest("hex");
  const storageRoot = config.workspaceStorageRoot || config.workspaceRoot;
  const ownerRoot = path.join(storageRoot, "users", ownerKey);
  const root = workspaceKey === "default" ? ownerRoot : path.join(ownerRoot, "sessions", workspaceKey);
  const cacheKey = ownerKey + ":" + workspaceKey;
  if (!workspaceServices.has(cacheKey)) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(root, 0o700); } catch {}
    const service = new WorkspaceService(root, cacheKey, {
      quotaRoot: ownerRoot,
      lockRoot: path.join(ownerRoot, ".ath-locks"),
    });
    service.workspaceKey = workspaceKey;
    service.ownerKey = ownerKey;
    workspaceServices.set(cacheKey, service);
  }
  return workspaceServices.get(cacheKey);
}

// Retained for trusted internal/system operations only. Request handlers must
// use getWorkspaceService(req.user.id) and must never expose this shared root.
export const workspaceService = new WorkspaceService();
