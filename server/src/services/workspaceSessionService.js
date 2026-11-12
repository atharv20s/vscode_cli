import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { config } from "../config/env.js";
import { getWorkspaceService } from "./workspaceService.js";

function getOwnerRoot(userId) {
  if (typeof userId !== "string" || !userId.trim()) throw new Error("Authenticated workspace owner is required.");
  const owner = crypto.createHash("sha256").update(userId).digest("hex");
  return path.join(config.workspaceStorageRoot || config.workspaceRoot, "users", owner);
}

async function withRegistryLock(ownerRoot, callback) {
  const lockDir = path.join(ownerRoot, ".ath-locks");
  const lockPath = path.join(lockDir, "registry.lock");
  await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
  const start = Date.now();
  let handle = null;
  while (!handle) {
    try { handle = await fs.open(lockPath, "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > 30000) { await fs.unlink(lockPath).catch(() => {}); continue; }
      } catch (statError) { if (statError.code === "ENOENT") continue; throw statError; }
      if (Date.now() - start > 8000) {
        const busy = new Error("Workspace registry is busy. Retry shortly.");
        busy.code = "WORKSPACE_BUSY";
        throw busy;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try { return await callback(); }
  finally { await handle.close().catch(() => {}); await fs.unlink(lockPath).catch(() => {}); }
}

async function readRegistry(ownerRoot) {
  const file = path.join(ownerRoot, ".ath-workspaces.json");
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return [];
  }
}

async function writeRegistry(ownerRoot, sessions) {
  const file = path.join(ownerRoot, ".ath-workspaces.json");
  const temp = file + "." + process.pid + "." + crypto.randomBytes(5).toString("hex") + ".tmp";
  await fs.writeFile(temp, JSON.stringify(sessions, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { await fs.rename(temp, file); }
  finally { await fs.unlink(temp).catch(() => {}); }
}

export async function listWorkspaceSessions(userId) {
  const ownerRoot = getOwnerRoot(userId);
  await fs.mkdir(ownerRoot, { recursive: true, mode: 0o700 });
  return withRegistryLock(ownerRoot, async () => {
    const sessions = await readRegistry(ownerRoot);
    if (!sessions.some(item => item.id === "default")) {
      sessions.unshift({ id: "default", name: "My workspace", createdAt: new Date().toISOString() });
      await writeRegistry(ownerRoot, sessions);
    }
    return sessions;
  });
}

export async function createWorkspaceSession(userId, name) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 48) {
    throw new Error("Workspace name must contain 1–48 characters.");
  }
  const ownerRoot = getOwnerRoot(userId);
  await fs.mkdir(ownerRoot, { recursive: true, mode: 0o700 });
  return withRegistryLock(ownerRoot, async () => {
    const sessions = await readRegistry(ownerRoot);
    if (sessions.length >= config.workspaceMaxSessionsPerUser) {
      const error = new Error("Workspace session limit reached.");
      error.code = "WORKSPACE_SESSION_LIMIT";
      throw error;
    }
    const id = "ws_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    const session = { id, name: name.trim(), createdAt: new Date().toISOString() };
    getWorkspaceService(userId, id);
    sessions.push(session);
    await writeRegistry(ownerRoot, sessions);
    return session;
  });
}

export async function ensureWorkspaceSession(userId, workspaceId = "default") {
  if (workspaceId === "default") return { id: "default", name: "My workspace" };
  if (typeof workspaceId !== "string" || !/^(ws_[a-f0-9]{20})$/.test(workspaceId)) {
    const error = new Error("Invalid workspace identifier.");
    error.code = "INVALID_WORKSPACE_ID";
    throw error;
  }
  const sessions = await listWorkspaceSessions(userId);
  const session = sessions.find(item => item.id === workspaceId);
  if (!session) {
    const error = new Error("Workspace does not exist for this account.");
    error.code = "WORKSPACE_NOT_FOUND";
    throw error;
  }
  return session;
}

export function getWorkspaceSession(userId, workspaceId = "default") {
  if (typeof workspaceId !== "string" || !/^(default|ws_[a-f0-9]{20})$/.test(workspaceId)) {
    const error = new Error("Invalid workspace identifier.");
    error.code = "INVALID_WORKSPACE_ID";
    throw error;
  }
  return getWorkspaceService(userId, workspaceId);
}
