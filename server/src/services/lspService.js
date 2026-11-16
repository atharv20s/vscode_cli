/**
 * Workspace-scoped LSP process bridge.
 *
 * One language server per authenticated WebSocket/workspace. Processes are
 * launched without a shell, inherit only a minimal environment, and are
 * stopped when the owning socket closes.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const COMMANDS = Object.freeze({
  typescript: { bin: "typescript-language-server", args: ["--stdio"], extensions: new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) },
  python: { bin: "pyright-langserver", args: ["--stdio"], extensions: new Set([".py", ".pyi"]) },
});

function executable(name) {
  const override = name === "typescript-language-server" ? process.env.ATH_LSP_TYPESCRIPT_BIN : process.env.ATH_LSP_PYTHON_BIN;
  return override || name;
}

function send(ws, type, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type, payload }));
}

function parseFrames(state, chunk, onMessage) {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  if (state.buffer.length > MAX_BUFFER_BYTES) throw new Error("LSP output buffer limit exceeded.");
  while (true) {
    const boundary = state.buffer.indexOf("\r\n\r\n");
    if (boundary < 0) return;
    const header = state.buffer.subarray(0, boundary).toString("ascii");
    const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
    if (!match) throw new Error("Invalid LSP Content-Length header.");
    const length = Number(match[1]);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_FRAME_BYTES) throw new Error("LSP frame exceeds the allowed size.");
    const frameEnd = boundary + 4 + length;
    if (state.buffer.length < frameEnd) return;
    const body = state.buffer.subarray(boundary + 4, frameEnd).toString("utf8");
    state.buffer = state.buffer.subarray(frameEnd);
    let message;
    try { message = JSON.parse(body); } catch { continue; }
    onMessage(message);
  }
}

export function startLanguageServer(ws, language) {
  if (ws.workspacePermission !== "owner") throw new Error("Language servers are available to workspace owners only.");
  const config = COMMANDS[language];
  if (!config) throw new Error("Unsupported language server.");
  stopLanguageServer(ws);
  const child = spawn(executable(config.bin), config.args, {
    cwd: ws.workspaceService.workspaceRoot,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
      TMPDIR: process.env.TMPDIR || "/tmp",
      TEMP: process.env.TEMP || "/tmp",
      LANG: process.env.LANG || "C.UTF-8",
      NODE_OPTIONS: "",
    },
  });
  const state = { child, buffer: Buffer.alloc(0), language, closed: false, workspaceRoot: ws.workspaceService.workspaceRoot, workspaceService: ws.workspaceService };
  ws.languageServer = state;
  child.stdout.on("data", chunk => {
    try {
      parseFrames(state, chunk, message => send(ws, "lsp.message", message));
    } catch (error) {
      send(ws, "lsp.error", { message: error.message });
      stopLanguageServer(ws);
    }
  });
  child.stderr.on("data", chunk => {
    const message = chunk.toString("utf8").slice(0, 2000);
    if (message.trim()) send(ws, "lsp.log", { message });
  });
  child.on("error", error => send(ws, "lsp.error", { message: "Unable to start " + config.bin + ": " + error.message }));
  child.on("exit", (code, signal) => {
    if (ws.languageServer === state) ws.languageServer = null;
    state.closed = true;
    send(ws, "lsp.exit", { language, code, signal });
  });
  const rootUri = pathToFileURL(ws.workspaceService.workspaceRoot + path.sep).href;
  send(ws, "lsp.started", { language, pid: child.pid, rootUri });
  return { language, pid: child.pid, rootUri };
}

export function sendLanguageServerMessage(ws, message) {
  const state = ws.languageServer;
  if (!state || state.closed || !state.child.stdin.writable) throw new Error("Language server is not running.");
  const validateUris = value => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" && /(?:^|_)uri$/i.test(key) && child.startsWith("file:")) {
        let absolute;
        try { absolute = fileURLToPath(child); } catch { throw new Error("Invalid file URI in LSP request."); }
        const relative = path.relative(state.workspaceRoot, absolute);
        if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative) || relative.includes("\\0")) {
          throw new Error("LSP file access is restricted to the active workspace.");
        }
        const checked = state.workspaceService.resolvePath(relative || ".");
        if (!checked.safe) throw new Error("LSP file access is restricted to the active workspace.");
      } else if (child && typeof child === "object") validateUris(child);
    }
  };
  validateUris(message.params);
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (!body.length || body.length > MAX_FRAME_BYTES) throw new Error("LSP request exceeds the allowed size.");
  state.child.stdin.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\r\n\r\n", "ascii"), body]));
}

export function stopLanguageServer(ws) {
  const state = ws.languageServer;
  if (!state) return;
  ws.languageServer = null;
  state.closed = true;
  try { state.child.stdin.end(); } catch {}
  const timer = setTimeout(() => {
    if (state.child.exitCode === null) state.child.kill("SIGKILL");
  }, 1500);
  timer.unref?.();
  state.child.once("exit", () => clearTimeout(timer));
  if (state.child.exitCode === null) state.child.kill("SIGTERM");
}
