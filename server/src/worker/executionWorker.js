/**
 * Private HTTP execution-worker entry point.
 *
 * Run only on a dedicated Linux host with Docker Engine. The API and worker
 * authenticate using an HMAC over timestamp, nonce, and exact request bytes.
 */
import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { config, validateConfig } from "../config/env.js";
import { dockerWorkspaceRuntime } from "../services/dockerWorkspaceRuntime.js";

const app = express();
const PORT = Number(process.env.WORKER_PORT || 8081);
const MAX_FILES = 4000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const replayedNonces = new Map();
const workspaceLocks = new Map();

function safeWorkspaceId(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function safeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/") || value.includes("\0")) return false;
  const parts = value.split("/");
  return parts.every(part => part && part !== "." && part !== "..");
}

function verifyRequest(req, res, next) {
  const secret = process.env.WORKER_SHARED_SECRET || "";
  const timestamp = req.header("x-worker-timestamp") || "";
  const nonce = req.header("x-worker-nonce") || "";
  const supplied = req.header("x-worker-signature") || "";
  const time = Number(timestamp);
  if (secret.length < 32 || !Number.isFinite(time) || Math.abs(Date.now() - time) > 5 * 60 * 1000 || !/^[a-f0-9-]{16,80}$/i.test(nonce) || !/^[a-f0-9]{64}$/i.test(supplied)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  for (const [key, expiry] of replayedNonces) if (expiry < Date.now()) replayedNonces.delete(key);
  if (replayedNonces.has(nonce)) return res.status(401).json({ error: "Replay rejected" });
  const expected = crypto.createHmac("sha256", secret).update(timestamp).update(".").update(nonce).update(".").update(req.body).digest();
  const actual = Buffer.from(supplied, "hex");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return res.status(401).json({ error: "Unauthorized" });
  replayedNonces.set(nonce, Date.now() + 5 * 60 * 1000);
  next();
}

function withWorkspaceLock(id, task) {
  const previous = workspaceLocks.get(id) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  workspaceLocks.set(id, current);
  return current.finally(() => {
    if (workspaceLocks.get(id) === current) workspaceLocks.delete(id);
  });
}

async function replaceWorkspace(root, files) {
  if (!Array.isArray(files) || files.length > MAX_FILES) throw new Error("Invalid workspace file list.");
  let total = 0;
  const validated = files.map(file => {
    if (!file || !safeRelativePath(file.path) || typeof file.content !== "string") throw new Error("Invalid workspace file entry.");
    const bytes = Buffer.from(file.content, "base64");
    if (bytes.length > MAX_FILE_BYTES || bytes.toString("base64") !== file.content) throw new Error("Invalid or oversized workspace file.");
    total += bytes.length;
    return { path: file.path, bytes };
  });
  if (total > MAX_TOTAL_BYTES) throw new Error("Workspace snapshot exceeds 12 MB transfer limit.");

  await fs.promises.rm(root, { recursive: true, force: true });
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  for (const file of validated) {
    const target = path.resolve(root, ...file.path.split("/"));
    if (!target.startsWith(root + path.sep)) throw new Error("Workspace path escaped root.");
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(target, file.bytes, { flag: "wx", mode: 0o600 });
  }
}

async function readWorkspace(root) {
  const output = [];
  let total = 0;
  async function walk(dir, relative = "") {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if ([".git", "node_modules", ".next", "dist", "build", ".cache"].includes(entry.name)) continue;
      const rel = relative ? relative + "/" + entry.name : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) {
        const stat = await fs.promises.stat(full);
        if (stat.size > MAX_FILE_BYTES) continue;
        total += stat.size;
        if (total > MAX_TOTAL_BYTES || output.length >= MAX_FILES) throw new Error("Workspace result exceeds transfer limits.");
        output.push({ path: rel, content: (await fs.promises.readFile(full)).toString("base64") });
      }
    }
  }
  await walk(root);
  return output;
}

app.get("/healthz", (_req, res) => res.json({ status: "ok", role: "execution-worker" }));
app.post("/v1/execute", express.raw({ type: "application/json", limit: "20mb" }), verifyRequest, async (req, res) => {
  try {
    const input = JSON.parse(req.body.toString("utf8"));
    const { workspaceId, files, command, cwd = ".", timeout = 45000 } = input;
    if (!safeWorkspaceId(workspaceId) || typeof command !== "string" || !command.trim() || command.length > 20000) {
      return res.status(400).json({ error: "Invalid execution request." });
    }
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) {
      return res.status(400).json({ error: "Timeout must be between 1 and 120 seconds." });
    }
    if (typeof cwd !== "string" || cwd.startsWith("/") || cwd.split("/").some(p => p === "..")) {
      return res.status(400).json({ error: "Invalid working directory." });
    }
    const result = await withWorkspaceLock(workspaceId, async () => {
      const root = path.join(config.workspaceRoot, "remote-users", workspaceId);
      // Remove any prior container before replacing its bind-mounted workspace directory.\n      await dockerWorkspaceRuntime.stop(workspaceId);\n      await replaceWorkspace(root, files);
      const resolvedCwd = path.resolve(root, cwd);
      if (resolvedCwd !== root && !resolvedCwd.startsWith(root + path.sep)) throw new Error("Working directory escaped workspace.");
      const execution = await dockerWorkspaceRuntime.execute({
        workspaceId,
        workspaceDir: root,
        cwd: resolvedCwd,
        command,
        timeout,
      });
      const updatedFiles = await readWorkspace(root);
      return { execution, files: updatedFiles };
    });
    res.json(result);
  } catch (error) {
    const status = /transfer limits|Invalid workspace|Invalid or oversized|escaped|Invalid working/.test(error.message) ? 400 : 500;
    res.status(status).json({ error: status === 400 ? error.message : "Worker execution failed." });
  }
});

const { errors } = validateConfig();
if (errors.length) throw new Error("Worker configuration invalid: " + errors.join("; "));
if (config.executionRuntime !== "docker") throw new Error("Execution worker requires EXECUTION_RUNTIME=docker.");
if ((process.env.WORKER_SHARED_SECRET || "").length < 32) throw new Error("WORKER_SHARED_SECRET must contain at least 32 characters.");

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ATH IDE execution worker listening on port ${PORT}`);
});
