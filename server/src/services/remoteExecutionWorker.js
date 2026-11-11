/**
 * Cloud Run -> dedicated execution worker client.
 * Transfers a bounded workspace snapshot and authenticates exact bytes with HMAC.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { config } from "../config/env.js";

const MAX_FILES = 4000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const IGNORED = new Set([".git", "node_modules", ".next", "dist", "build", ".cache"]);

async function collectFiles(root) {
  const files = [];
  let total = 0;
  async function walk(dir, relative = "") {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue;
      const rel = relative ? relative + "/" + entry.name : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) {
        const stat = await fs.promises.stat(full);
        if (stat.size > MAX_FILE_BYTES) throw new Error(`Workspace file ${rel} exceeds the 2 MB worker transfer limit.`);
        total += stat.size;
        if (total > MAX_TOTAL_BYTES || files.length >= MAX_FILES) throw new Error("Workspace exceeds the 12 MB / 4,000-file worker transfer limit. Configure persistent shared workspace storage for larger projects.");
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
    if (!file || typeof file.path !== "string" || !file.path || file.path.includes("\\") || file.path.startsWith("/") || file.path.split("/").some(p => !p || p === "." || p === "..") || typeof file.content !== "string") {
      throw new Error("Execution worker returned an unsafe file path.");
    }
    const bytes = Buffer.from(file.content, "base64");
    if (bytes.length > MAX_FILE_BYTES || bytes.toString("base64") !== file.content) throw new Error("Execution worker returned an invalid file.");
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error("Execution worker response exceeds transfer limit.");
    next.set(file.path, bytes);
  }
  const previous = await collectFiles(root);
  for (const file of previous) {
    if (next.has(file.path)) continue;
    const target = path.resolve(root, ...file.path.split("/"));
    if (!target.startsWith(root + path.sep)) throw new Error("Refusing to remove a path outside the workspace.");
    await fs.promises.rm(target, { force: true });
  }
  for (const [relative, bytes] of next) {
    const target = path.resolve(root, ...relative.split("/"));
    if (!target.startsWith(root + path.sep)) throw new Error("Refusing to write outside the workspace.");
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, bytes, { mode: 0o600 });
  }
}

export async function executeOnRemoteWorker({ workspaceId, workspaceDir, cwd, command, timeout = 45000, signal }) {
  const url = config.executionWorkerUrl;
  const secret = config.workerSharedSecret;
  if (!url || secret.length < 32) throw new Error("Remote execution worker is not configured.");
  if (!path.isAbsolute(workspaceDir)) throw new Error("Workspace directory must be absolute.");
  const files = await collectFiles(workspaceDir);
  const relativeCwd = path.relative(workspaceDir, cwd || workspaceDir).split(path.sep).join("/") || ".";
  if (relativeCwd === ".." || relativeCwd.startsWith("../") || path.isAbsolute(relativeCwd)) throw new Error("Execution working directory is outside the workspace.");
  const body = Buffer.from(JSON.stringify({ workspaceId, files, cwd: relativeCwd, command, timeout }));
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const signature = crypto.createHmac("sha256", secret).update(timestamp).update(".").update(nonce).update(".").update(body).digest("hex");
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeout + 20000);
  try {
    const response = await fetch(new URL("/v1/execute", url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-worker-timestamp": timestamp,
        "x-worker-nonce": nonce,
        "x-worker-signature": signature,
      },
      body,
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Execution worker returned HTTP ${response.status}.`);
    await applyFiles(workspaceDir, payload.files);
    return payload.execution;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
