/**
 * Private execution worker with persistent per-workspace directories/containers.
 * HMAC authentication binds each request to its HTTP method, path and body.
 */
import express from "express";
import http from "http";
import crypto from "crypto";
import pty from "node-pty";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { config, validateConfig } from "../config/env.js";
import { dockerWorkspaceRuntime } from "../services/dockerWorkspaceRuntime.js";
import { execFileSync as dockerExecFileSync } from "child_process";

const app = express();
const PORT = Number(process.env.WORKER_PORT || 8081);
const MAX_FILES = 4000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const IGNORED = new Set([".git", "node_modules", ".next", "dist", "build", ".cache"]);
const replayedNonces = new Map();
const inFlight = new Map();

function safeWorkspaceId(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function safeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/") || value.includes("\0")) return false;
  return value.split("/").every(part => part && part !== "." && part !== "..");
}

function verifySignature({ method, requestPath, body, headers }) {
  const secret = process.env.WORKER_SHARED_SECRET || "";
  const timestamp = headers["x-worker-timestamp"] || "";
  const nonce = headers["x-worker-nonce"] || "";
  const supplied = headers["x-worker-signature"] || "";
  const time = Number(timestamp);
  if (secret.length < 32 || !Number.isFinite(time) || Math.abs(Date.now() - time) > 5 * 60 * 1000 ||
      !/^[a-f0-9-]{16,80}$/i.test(nonce) || !/^[a-f0-9]{64}$/i.test(supplied)) return false;
  for (const [key, expiry] of replayedNonces) if (expiry < Date.now()) replayedNonces.delete(key);
  if (replayedNonces.has(nonce)) return false;
  const expected = crypto.createHmac("sha256", secret)
    .update(timestamp).update(".").update(nonce).update(".")
    .update(method.toUpperCase()).update(".").update(requestPath).update(".")
    .update(body).digest();
  const actual = Buffer.from(supplied, "hex");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
  replayedNonces.set(nonce, Date.now() + 5 * 60 * 1000);
  return true;
}

function verifyRequest(req, res, next) {
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!verifySignature({ method: req.method, requestPath: req.originalUrl, body, headers: req.headers })) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function withWorkspaceLock(id, task) {
  const previous = inFlight.get(id) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  inFlight.set(id, current);
  return current.finally(() => {
    if (inFlight.get(id) === current) inFlight.delete(id);
  });
}

async function withWorkspaceFileLock(id, task) {
  const lockRoot = path.join(config.workspaceRoot, ".ath-locks");
  await fs.promises.mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const lockPath = path.join(lockRoot, id + ".lock");
  const started = Date.now();
  let handle = null;
  while (!handle) {
    try {
      handle = await fs.promises.open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const stat = await fs.promises.stat(lockPath);
        if (Date.now() - stat.mtimeMs > 300000) {
          await fs.promises.unlink(lockPath).catch(() => {});
          continue;
        }
      } catch (statError) {
        if (statError.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() - started > 30000) {
        const busy = new Error("Workspace is busy on the execution worker.");
        busy.code = "WORKSPACE_BUSY";
        throw busy;
      }
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  const heartbeat = setInterval(() => {
    const now = new Date();
    fs.promises.utimes(lockPath, now, now).catch(() => {});
  }, 10000);
  heartbeat.unref?.();
  try { return await task(); }
  finally {
    clearInterval(heartbeat);
    await handle.close().catch(() => {});
    await fs.promises.unlink(lockPath).catch(() => {});
  }
}

function workspaceRootFor(id) {
  if (!safeWorkspaceId(id)) throw new Error("Invalid workspace identity.");
  return path.join(config.workspaceRoot, "remote-users", id);
}

async function readManagedManifest(root) {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(path.join(root, ".ath-managed-files.json"), "utf8"));
    return Array.isArray(parsed) ? parsed.filter(safeRelativePath) : [];
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return [];
  }
}
async function writeManagedManifest(root, paths) {
  const file = path.join(root, ".ath-managed-files.json");
  const temporary = file + "." + process.pid + "." + crypto.randomBytes(5).toString("hex") + ".tmp";
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(paths.sort()), { flag: "wx", mode: 0o600 });
    await fs.promises.rename(temporary, file);
  } finally { await fs.promises.unlink(temporary).catch(() => {}); }
}

async function replaceWorkspace(root, files) {
  if (!Array.isArray(files) || files.length > MAX_FILES) throw new Error("Invalid workspace file list.");
  const validated = [];
  const incoming = new Set();
  let total = 0;
  for (const file of files) {
    if (!file || !safeRelativePath(file.path) || typeof file.content !== "string") throw new Error("Invalid workspace file entry.");
    if (IGNORED.has(file.path.split("/")[0])) continue;
    const bytes = Buffer.from(file.content, "base64");
    if (bytes.length > MAX_FILE_BYTES || bytes.toString("base64") !== file.content) throw new Error("Invalid or oversized workspace file.");
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error("Workspace snapshot exceeds 12 MB transfer limit.");
    if (incoming.has(file.path)) throw new Error("Workspace snapshot contains duplicate paths.");
    incoming.add(file.path);
    validated.push({ path: file.path, bytes });
  }

  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  const previous = await readManagedManifest(root);
  // Delete only previously synchronized files which the latest API snapshot removed.
  // Runtime-generated files and package caches remain untouched.
  for (const relative of previous) {
    if (incoming.has(relative)) continue;
    const target = path.resolve(root, ...relative.split("/"));
    if (!target.startsWith(root + path.sep)) throw new Error("Refusing to remove a path outside the workspace.");
    await fs.promises.rm(target, { force: true });
  }
  // Update only changed files so long-running processes and dependency caches survive.
  for (const file of validated) {
    const target = path.resolve(root, ...file.path.split("/"));
    if (!target.startsWith(root + path.sep)) throw new Error("Workspace path escaped root.");
    const current = await fs.promises.readFile(target).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (current?.equals(file.bytes)) continue;
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = target + "." + process.pid + "." + crypto.randomBytes(5).toString("hex") + ".tmp";
    try {
      await fs.promises.writeFile(temporary, file.bytes, { flag: "wx", mode: 0o600 });
      await fs.promises.rename(temporary, target);
    } finally { await fs.promises.unlink(temporary).catch(() => {}); }
  }
  await writeManagedManifest(root, Array.from(incoming));
}

async function readWorkspace(root) {
  const output = [];
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

async function measureWorkspaceBytes(root) {
  let total = 0;
  async function walk(dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) total += (await fs.promises.stat(full)).size;
    }
  }
  await walk(root);
  return total;
}

async function syncWorkspace(workspaceId, files) {
  const root = workspaceRootFor(workspaceId);
  return withWorkspaceLock(workspaceId, () => withWorkspaceFileLock(workspaceId, async () => {
    await replaceWorkspace(root, files);
    return { workspaceId, syncedFiles: files.length };
  }));
}

app.get("/healthz", (_req, res) => res.json({ status: "ok", role: "execution-worker" }));

app.post("/v1/workspace/sync", express.raw({ type: "application/json", limit: "20mb" }), verifyRequest, async (req, res) => {
  try {
    const input = JSON.parse(req.body.toString("utf8"));
    const result = await syncWorkspace(input.workspaceId, input.files);
    res.json({ success: true, ...result });
  } catch (error) {
    const status = /Invalid workspace|Invalid or oversized|transfer limit|escaped|unsafe|duplicate/.test(error.message) ? 400 : error.code === "WORKSPACE_BUSY" ? 423 : 500;
    res.status(status).json({ error: status === 400 || status === 423 ? error.message : "Workspace sync failed." });
  }
});

app.post("/v1/execute", express.raw({ type: "application/json", limit: "20mb" }), verifyRequest, async (req, res) => {
  try {
    const input = JSON.parse(req.body.toString("utf8"));
    const { workspaceId, files, command, cwd = ".", timeout = 45000 } = input;
    if (!safeWorkspaceId(workspaceId) || typeof command !== "string" || !command.trim() || command.length > 20000) {
      return res.status(400).json({ error: "Invalid execution request." });
    }
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 300000) return res.status(400).json({ error: "Timeout must be between 1 and 300 seconds." });
    if (typeof cwd !== "string" || cwd.startsWith("/") || cwd.split("/").some(p => p === "..")) {
      return res.status(400).json({ error: "Invalid working directory." });
    }

    const result = await withWorkspaceLock(workspaceId, () => withWorkspaceFileLock(workspaceId, async () => {
      const root = workspaceRootFor(workspaceId);
      await replaceWorkspace(root, files);
      const resolvedCwd = path.resolve(root, cwd);
      if (resolvedCwd !== root && !resolvedCwd.startsWith(root + path.sep)) throw new Error("Working directory escaped workspace.");

      // Reuse the per-workspace container. Stopping it here destroys running
      // previews, tmux sessions and package caches, so containers are no longer
      // recreated for every command.
      const execution = await dockerWorkspaceRuntime.execute({
        workspaceId, workspaceDir: root, cwd: resolvedCwd, command, timeout,
      });
      const quotaBytes = Math.max(64 * 1024 * 1024, Number(process.env.WORKER_WORKSPACE_QUOTA_BYTES || 1073741824));
      const usedBytes = await measureWorkspaceBytes(root);
      if (usedBytes > quotaBytes) {
        return {
          execution: { success: false, exitCode: -1, output: "Workspace storage quota exceeded. Remove build artifacts or dependencies before continuing." },
          files: await readWorkspace(root),
        };
      }
      return { execution, files: await readWorkspace(root) };
    }));
    res.json(result);
  } catch (error) {
    const status = /transfer limits|Invalid workspace|Invalid or oversized|escaped|Invalid working/.test(error.message) ? 400 : error.code === "WORKSPACE_BUSY" ? 423 : 500;
    res.status(status).json({ error: status === 400 || status === 423 ? error.message : "Worker execution failed." });
  }
});

function validatePreviewPort(port) {
  return Number.isInteger(Number(port)) && Number(port) >= 1024 && Number(port) <= 65535;
}

function getPreviewPath(req, workspaceId, port) {
  const parsed = new URL(req.originalUrl, "http://worker");
  const prefix = "/v1/preview/" + workspaceId + "/" + port;
  const suffix = parsed.pathname.slice(prefix.length) || "/";
  return (suffix.startsWith("/") ? suffix : "/" + suffix) + parsed.search;
}

async function waitForPreview(address, port, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const response = await fetch("http://" + address + ":" + port + "/", { signal: AbortSignal.timeout(1200) });
      if (response.status < 500) return true;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

async function proxyPreviewHttp(req, res) {
  const workspaceId = req.params.workspaceId;
  const port = Number(req.params.port);
  if (!safeWorkspaceId(workspaceId) || !validatePreviewPort(port)) return res.status(400).end();
  try {
    const address = await dockerWorkspaceRuntime.getContainerAddress(workspaceId);
    const upstream = http.request({
      hostname: address, port, method: req.method,
      path: getPreviewPath(req, workspaceId, port),
      headers: {
        accept: req.headers.accept || "*/*",
        "content-type": req.headers["content-type"],
        "content-length": Buffer.isBuffer(req.body) ? req.body.length : 0,
        "user-agent": req.headers["user-agent"] || "ATH-IDE-Preview-Proxy",
        host: address + ":" + port,
        "x-forwarded-host": req.headers.host || "",
        "x-forwarded-proto": "https",
      },
    }, upstreamRes => {
      res.statusCode = upstreamRes.statusCode || 502;
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (["connection", "transfer-encoding", "keep-alive", "content-length"].includes(name.toLowerCase())) continue;
        if (name.toLowerCase() === "x-frame-options") continue;
        res.setHeader(name, value);
      }
      upstreamRes.pipe(res);
    });
    upstream.on("error", error => {
      if (!res.headersSent) res.status(502).json({ error: "PreviewUnavailable", message: error.message });
      else res.end();
    });
    upstream.end(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
  } catch (error) {
    if (!res.headersSent) res.status(502).json({ error: "PreviewUnavailable", message: error.message });
    else res.end();
  }
}

async function startPreviewOnWorker(input) {
  const { workspaceId, files, cwd = ".", command, port } = input;
  if (!safeWorkspaceId(workspaceId) || typeof command !== "string" || !command.trim() || command.length > 20000 || !validatePreviewPort(port)) {
    throw new Error("Invalid preview request.");
  }
  if (typeof cwd !== "string" || cwd.startsWith("/") || cwd.split("/").some(part => part === "..")) throw new Error("Invalid preview working directory.");
  const root = workspaceRootFor(workspaceId);
  return withWorkspaceLock(workspaceId, () => withWorkspaceFileLock(workspaceId, async () => {
    await replaceWorkspace(root, files);
    const resolvedCwd = path.resolve(root, cwd);
    if (resolvedCwd !== root && !resolvedCwd.startsWith(root + path.sep)) throw new Error("Preview working directory escaped workspace.");
    const container = await dockerWorkspaceRuntime.ensureContainer(workspaceId, root);
    await stopPreviewOnWorker(workspaceId, port);
    const relativeCwd = path.relative(root, resolvedCwd).split(path.sep).join("/") || ".";
    const containerCwd = relativeCwd === "." ? "/workspace" : "/workspace/" + relativeCwd;
    const script = 'nohup setsid /bin/bash -lc "$ATH_PREVIEW_COMMAND" > /tmp/ath-preview-' + port + '.log 2>&1 < /dev/null & echo $! > /tmp/ath-preview-' + port + '.pid; cat /tmp/ath-preview-' + port + '.pid';
    const pid = execDocker([
      "exec", "-w", containerCwd,
      "-e", "ATH_PREVIEW_COMMAND=" + command,
      "-e", "PORT=" + port, "-e", "HOST=0.0.0.0", "-e", "HOSTNAME=0.0.0.0",
      container, "/bin/bash", "-lc", script,
    ], { encoding: "utf8" }).trim();
    const address = await dockerWorkspaceRuntime.getContainerAddress(workspaceId);
    const ready = await waitForPreview(address, port);
    if (!ready) {
      let log = "";
      try { log = execDocker(["exec", container, "tail", "-n", "80", "/tmp/ath-preview-" + port + ".log"], { encoding: "utf8" }); } catch {}
      throw new Error("Preview server did not become ready on port " + port + ". " + log.slice(-5000));
    }
    return { success: true, workspaceId, port, pid, status: "running" };
  }));
}

async function stopPreviewOnWorker(workspaceId, port) {
  if (!safeWorkspaceId(workspaceId) || !validatePreviewPort(port)) throw new Error("Invalid preview stop request.");
  const container = await dockerWorkspaceRuntime.ensureContainer(workspaceId, workspaceRootFor(workspaceId));
  const script = "if [ -f /tmp/ath-preview-" + port + ".pid ]; then pid=$(cat /tmp/ath-preview-" + port + ".pid); kill -TERM -- \"-$pid\" 2>/dev/null || kill -TERM \"$pid\" 2>/dev/null || true; sleep 0.2; kill -KILL -- \"-$pid\" 2>/dev/null || true; rm -f /tmp/ath-preview-" + port + ".pid; fi";
  try { execDocker(["exec", container, "/bin/bash", "-lc", script]); } catch {}
  return { success: true, stopped: true, port };
}
app.post("/v1/preview/start", express.raw({ type: "application/json", limit: "20mb" }), verifyRequest, async (req, res) => {
  try { res.json(await startPreviewOnWorker(JSON.parse(req.body.toString("utf8")))); }
  catch (error) {
    const status = /Invalid|escaped|outside workspace|snapshot|transfer limit/.test(error.message) ? 400 : error.code === "WORKSPACE_BUSY" ? 423 : 502;
    res.status(status).json({ error: status === 400 || status === 423 ? error.message : "Preview failed to start.", detail: error.message.slice(0, 5000) });
  }
});
app.post("/v1/preview/stop", express.raw({ type: "application/json", limit: "64kb" }), verifyRequest, async (req, res) => {
  try { const input = JSON.parse(req.body.toString("utf8")); res.json(await stopPreviewOnWorker(input.workspaceId, input.port)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.all("/v1/preview/:workspaceId/:port/*", express.raw({ type: () => true, limit: "4mb" }), verifyRequest, proxyPreviewHttp);

const { errors } = validateConfig();
if (errors.length) throw new Error("Worker configuration invalid: " + errors.join("; "));
if (config.executionRuntime !== "docker") throw new Error("Execution worker requires EXECUTION_RUNTIME=docker.");
if ((process.env.WORKER_SHARED_SECRET || "").length < 32) throw new Error("WORKER_SHARED_SECRET must contain at least 32 characters.");


const server = http.createServer(app);
const terminalWss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });

function sendTerminal(ws, type, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type, payload }));
}

async function attachPersistentTerminal(ws, { workspaceId, sessionId, cols, rows }) {
  const root = workspaceRootFor(workspaceId);
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  const container = await dockerWorkspaceRuntime.ensureContainer(workspaceId, root);
  const tmuxSession = "ath-" + sessionId.replace(/[^a-f0-9]/gi, "").slice(0, 32);

  // tmux lives inside the long-lived workspace container. Killing this worker
  // process or dropping a browser WebSocket only detaches the client; the
  // shell/process tree remains available for the next authenticated attach.
  try {
    execDocker(["exec", container, "tmux", "has-session", "-t", tmuxSession]);
  } catch {
    execDocker(["exec", container, "tmux", "new-session", "-d", "-s", tmuxSession, "-c", "/workspace"]);
  }

  let terminal;
  try {
    const captured = execDocker(["exec", container, "tmux", "capture-pane", "-p", "-t", tmuxSession, "-S", "-200"], { encoding: "utf8" });
    if (captured) sendTerminal(ws, "terminal.output", { text: captured + "\r\n", sessionId, replayed: true });
  } catch {}

  try {
    terminal = pty.spawn(config.dockerBinary, [
      "exec", "-it", "-e", "TERM=xterm-256color",
      container, "tmux", "attach-session", "-t", tmuxSession,
    ], {
      name: "xterm-256color",
      cols: Math.max(20, Math.min(300, Number(cols) || 80)),
      rows: Math.max(5, Math.min(120, Number(rows) || 24)),
      cwd: root,
      env: { ...process.env, TERM: "xterm-256color" },
    });
  } catch (error) {
    sendTerminal(ws, "terminal.state", { sessionId, state: "error", error: error.message });
    ws.close(1011, "Terminal attach failed");
    return;
  }

  sendTerminal(ws, "terminal.state", { sessionId, state: "ready", reconnected: true });
  terminal.onData(data => sendTerminal(ws, "terminal.output", { text: data, sessionId }));
  terminal.onExit(({ exitCode }) => {
    sendTerminal(ws, "terminal.state", { sessionId, state: "exited", exitCode });
    if (ws.readyState === 1) ws.close(1000, "Terminal exited");
  });

  ws.on("message", raw => {
    let message;
    try { message = JSON.parse(raw.toString("utf8")); }
    catch { sendTerminal(ws, "error", { message: "Invalid terminal message." }); return; }
    const payload = message.payload || {};
    switch (message.type) {
      case "terminal.input":
      case "terminal_input":
      case "terminal.keystroke":
        if (typeof payload.data === "string" && payload.data.length <= 16384) terminal.write(payload.data);
        break;
      case "terminal.paste":
        if (typeof payload.text === "string" && payload.text.length <= 65536) terminal.write(payload.text);
        break;
      case "terminal.resize": {
        const nextCols = Math.max(20, Math.min(300, Number(payload.cols) || 80));
        const nextRows = Math.max(5, Math.min(120, Number(payload.rows) || 24));
        try { terminal.resize(nextCols, nextRows); } catch {}
        break;
      }
      case "terminal.kill":
        try { terminal.kill(); } catch {}
        try { execDocker(["exec", container, "tmux", "kill-session", "-t", tmuxSession]); } catch {}
        break;
      case "ping":
        sendTerminal(ws, "pong", { timestamp: Date.now() });
        break;
      default:
        sendTerminal(ws, "error", { message: "Unsupported remote terminal message." });
    }
  });

  ws.on("close", () => {
    // Detach the PTY client only. Do not kill the tmux session.
    try { terminal?.kill(); } catch {}
  });
  ws.on("error", () => {
    try { terminal?.kill(); } catch {}
  });
}

function execDocker(args, options = {}) {
  const { execFileSync } = requireDockerExec();
  return execFileSync(config.dockerBinary, args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
    ...options,
  });
}

function requireDockerExec() {
  // Use the already configured Docker binary without shell interpolation.
  return { execFileSync: dockerExecFileSync };
}


server.on("upgrade", async (req, socket, head) => {
  let parsed;
  try { parsed = new URL(req.url, "http://worker"); }
  catch { socket.destroy(); return; }
  if (parsed.pathname.startsWith("/v1/preview/")) {
    const parts = parsed.pathname.split("/").filter(Boolean);
    const workspaceId = parts[2];
    const port = Number(parts[3]);
    if (!safeWorkspaceId(workspaceId) || !validatePreviewPort(port) ||
        !verifySignature({ method: "GET", requestPath: req.url, body: Buffer.alloc(0), headers: req.headers })) {
      socket.write("HTTP/1.1 401 Unauthorized\\r\\nConnection: close\\r\\n\\r\\n");
      socket.destroy();
      return;
    }
    try {
      const address = await dockerWorkspaceRuntime.getContainerAddress(workspaceId);
      const prefix = "/v1/preview/" + workspaceId + "/" + port;
      const suffix = parsed.pathname.slice(prefix.length) || "/";
      const upstream = http.request({
        hostname: address, port, method: "GET", path: suffix + parsed.search,
        headers: { ...req.headers, host: address + ":" + port },
      });
      upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
        const status = "HTTP/" + response.httpVersion + " " + response.statusCode + " " + response.statusMessage + "\\r\\n";
        const responseHeaders = Object.entries(response.headers).map(([name, value]) => name + ": " + value + "\\r\\n").join("");
        socket.write(status + responseHeaders + "\\r\\n");
        if (upstreamHead && upstreamHead.length) socket.write(upstreamHead);
        if (head && head.length) upstreamSocket.write(head);
        upstreamSocket.pipe(socket);
        socket.pipe(upstreamSocket);
      });
      upstream.on("response", response => {
        socket.write("HTTP/" + response.httpVersion + " " + response.statusCode + " " + response.statusMessage + "\\r\\n");
        for (const [name, value] of Object.entries(response.headers)) socket.write(name + ": " + value + "\\r\\n");
        socket.write("\\r\\n");
        response.pipe(socket);
      });
      upstream.on("error", () => socket.destroy());
      upstream.end();
    } catch { socket.destroy(); }
    return;
  }
  if (parsed.pathname !== "/v1/terminal") return;

  if (!verifySignature({
    method: "GET",
    requestPath: req.url,
    body: Buffer.alloc(0),
    headers: req.headers,
  })) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const workspaceId = parsed.searchParams.get("workspaceId");
  const sessionId = parsed.searchParams.get("sessionId");
  const cols = parsed.searchParams.get("cols");
  const rows = parsed.searchParams.get("rows");
  if (!safeWorkspaceId(workspaceId) || !/^[a-f0-9-]{36}$/i.test(sessionId || "")) {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  try {
    const root = workspaceRootFor(workspaceId);
    await dockerWorkspaceRuntime.ensureContainer(workspaceId, root);
    terminalWss.handleUpgrade(req, socket, head, ws => {
      attachPersistentTerminal(ws, { workspaceId, sessionId, cols, rows })
        .catch(error => {
          sendTerminal(ws, "terminal.state", { sessionId, state: "error", error: error.message });
          ws.close(1011, "Terminal setup failed");
        });
    });
  } catch {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    socket.destroy();
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`ATH IDE persistent execution worker listening on port ${PORT}`));

