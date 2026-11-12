/**
 * Cloud API -> dedicated execution worker client.
 *
 * Workspace identities are hashed before they leave the API process. The
 * worker maintains a persistent host directory and long-lived sandbox for
 * each opaque workspace key; the API sends a bounded, versioned snapshot.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { config } from "../config/env.js";

const MAX_FILES = 4000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const IGNORED = new Set([".git", "node_modules", ".next", "dist", "build", ".cache"]);

export function workspaceRuntimeKey(workspaceId) {
  if (typeof workspaceId !== "string" || !workspaceId.trim()) throw new Error("A stable workspace identity is required.");
  return crypto.createHash("sha256").update(workspaceId).digest("hex");
}

function signWorkerRequest(method, requestPath, body, secret) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const signature = crypto.createHmac("sha256", secret)
    .update(timestamp).update(".").update(nonce).update(".")
    .update(method.toUpperCase()).update(".").update(requestPath).update(".")
    .update(body).digest("hex");
  return { "x-worker-timestamp": timestamp, "x-worker-nonce": nonce, "x-worker-signature": signature };
}

function workerConfig() {
  const url = config.executionWorkerUrl;
  const secret = config.workerSharedSecret;
  if (!url || !url.startsWith("https://") || secret.length < 32) {
    throw new Error("Remote execution worker is not configured with HTTPS and a 32+ character shared secret.");
  }
  return { url: new URL(url), secret };
}

export async function collectWorkspaceFiles(root) {
  const files = [];
  let total = 0;
  async function walk(dir, relative = "") {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED.has(entry.name) || entry.name === ".ath-managed-files.json") continue;
      const rel = relative ? relative + "/" + entry.name : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) {
        const stat = await fs.promises.stat(full);
        if (stat.size > MAX_FILE_BYTES) throw new Error(`Workspace file ${rel} exceeds the 2 MB worker transfer limit.`);
        total += stat.size;
        if (total > MAX_TOTAL_BYTES || files.length >= MAX_FILES) {
          throw new Error("Workspace exceeds the 12 MB / 4,000-file worker transfer limit. Use the persistent shared workspace mount for larger projects.");
        }
        files.push({ path: rel, content: (await fs.promises.readFile(full)).toString("base64") });
      }
    }
  }
  await walk(root);
  return files;
}

async function applyFiles(root, returnedFiles) {
  if (!Array.isArray(returnedFiles) || returnedFiles.length > MAX_FILES) throw new Error("Execution worker returned an invalid workspace snapshot.");
  const next = new Map();
  let total = 0;
  for (const file of returnedFiles) {
    if (!file || typeof file.path !== "string" || !file.path || file.path.includes("\\") ||
        file.path.startsWith("/") || file.path.split("/").some(p => !p || p === "." || p === "..") ||
        typeof file.content !== "string") throw new Error("Execution worker returned an unsafe file path.");
    const bytes = Buffer.from(file.content, "base64");
    if (bytes.length > MAX_FILE_BYTES || bytes.toString("base64") !== file.content) throw new Error("Execution worker returned an invalid file.");
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error("Execution worker response exceeds transfer limit.");
    next.set(file.path, bytes);
  }

  const previous = await collectWorkspaceFiles(root);
  for (const file of previous) {
    if (next.has(file.path)) continue;
    const target = path.resolve(root, ...file.path.split("/"));
    if (!target.startsWith(root + path.sep)) throw new Error("Refusing to remove a path outside the workspace.");
    await fs.promises.rm(target, { force: true });
  }
  for (const [relative, bytes] of next) {
    const target = path.resolve(root, ...relative.split("/"));
    if (!target.startsWith(root + path.sep)) throw new Error("Refusing to write outside the workspace.");
    const current = await fs.promises.readFile(target).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (current?.equals(bytes)) continue;
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const temporary = target + "." + process.pid + "." + crypto.randomBytes(5).toString("hex") + ".tmp";
    try {
      await fs.promises.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await fs.promises.rename(temporary, target);
    } finally {
      await fs.promises.unlink(temporary).catch(() => {});
    }
  }
}

async function postWorkerJson(route, payload, { timeoutMs = 90000, signal } = {}) {
  const { url, secret } = workerConfig();
  const body = Buffer.from(JSON.stringify(payload || {}));
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(route, url), {
      method: "POST",
      headers: { "content-type": "application/json", ...signWorkerRequest("POST", route, body, secret) },
      body,
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Execution worker returned HTTP ${response.status}.`);
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function syncWorkspaceOnRemote({ workspaceId, workspaceDir, signal }) {
  if (!path.isAbsolute(workspaceDir)) throw new Error("Workspace directory must be absolute.");
  const files = await collectWorkspaceFiles(workspaceDir);
  return postWorkerJson("/v1/workspace/sync", {
    workspaceId: workspaceRuntimeKey(workspaceId),
    files,
  }, { timeoutMs: 90000, signal });
}

export async function executeOnRemoteWorker({ workspaceId, workspaceDir, cwd, command, timeout = 45000, signal }) {
  if (!path.isAbsolute(workspaceDir)) throw new Error("Workspace directory must be absolute.");
  const files = await collectWorkspaceFiles(workspaceDir);
  const relativeCwd = path.relative(workspaceDir, cwd || workspaceDir).split(path.sep).join("/") || ".";
  if (relativeCwd === ".." || relativeCwd.startsWith("../") || path.isAbsolute(relativeCwd)) throw new Error("Execution working directory is outside the workspace.");
  const result = await postWorkerJson("/v1/execute", {
    workspaceId: workspaceRuntimeKey(workspaceId), files, cwd: relativeCwd, command, timeout,
  }, { timeoutMs: timeout + 30000, signal });
  await applyFiles(workspaceDir, result.files);
  return result.execution;
}
