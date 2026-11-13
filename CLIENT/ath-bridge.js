#!/usr/bin/env node
/**
 * ATH IDE workstation bridge.
 *
 * The bridge reports workstation metadata by default. Remote shell execution
 * is opt-in and requires a local interactive approval for every command.
 * Remote commands are scoped to a configured workspace directory and run with
 * a minimal environment; disconnects and timeouts terminate child processes.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import WebSocket from "ws";

const args = process.argv.slice(2);
let serverUrl = "http://localhost:3001";
let authToken = "";
let workspaceRoot = process.cwd();
let allowRemoteExec = false;
let commandTimeoutMs = 120_000;
const MAX_COMMAND_LENGTH = 8_000;
const MAX_CONCURRENT_COMMANDS = 2;
const MAX_REQUESTS_PER_MINUTE = 8;
const children = new Map();
const recentRequests = [];

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--server" || arg === "-s") serverUrl = args[++index] || "";
  else if (arg === "--token" || arg === "-t") authToken = args[++index] || "";
  else if (arg === "--workspace" || arg === "-w") workspaceRoot = args[++index] || "";
  else if (arg === "--allow-remote-exec") allowRemoteExec = true;
  else if (arg === "--timeout-seconds") {
    const seconds = Number(args[++index]);
    if (!Number.isFinite(seconds) || seconds < 5 || seconds > 600) {
      throw new Error("--timeout-seconds must be between 5 and 600.");
    }
    commandTimeoutMs = seconds * 1000;
  } else if (arg === "--help" || arg === "-h") {
    console.log("Usage: node ath-bridge.js --server https://ide.example --token TOKEN --workspace DIR [--allow-remote-exec]");
    process.exit(0);
  } else {
    throw new Error("Unknown argument: " + arg);
  }
}

if (!serverUrl || !authToken) {
  throw new Error("Both --server and --token are required. No unauthenticated bridge session will be opened.");
}
if (!stdin.isTTY || !stdout.isTTY) {
  if (allowRemoteExec) throw new Error("Remote execution consent requires an interactive local terminal.");
}
workspaceRoot = await fs.realpath(path.resolve(workspaceRoot));
const server = new URL(serverUrl);
const localHost = ["localhost", "127.0.0.1", "::1"].includes(server.hostname);
if (!localHost && server.protocol !== "https:") {
  throw new Error("Remote bridge connections must use HTTPS/WSS.");
}
if (localHost && !["http:", "https:"].includes(server.protocol)) {
  throw new Error("Unsupported local server URL scheme.");
}
const wsUrl = new URL(server.toString());
wsUrl.protocol = server.protocol === "https:" ? "wss:" : "ws:";
wsUrl.pathname = "/ws";
wsUrl.search = "";
wsUrl.hash = "";
const clientName = `${os.userInfo().username}@${os.hostname()} (${os.platform()} ${os.arch()})`;
const rl = stdin.isTTY && stdout.isTTY ? readline.createInterface({ input: stdin, output: stdout }) : null;

function detectLocalRuntimes() {
  return {
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
    totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
    shells: os.platform() === "win32" ? ["powershell", "pwsh", "cmd"] : ["bash", "sh"],
  };
}

function send(type, payload) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type, payload }));
  }
}

function minimalEnvironment() {
  const allowed = os.platform() === "win32"
    ? ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "PATHEXT", "COMSPEC"]
    : ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME"];
  return Object.fromEntries(allowed.filter(key => process.env[key]).map(key => [key, process.env[key]]));
}

async function resolveWorkingDirectory(candidate) {
  const requested = candidate ? path.resolve(workspaceRoot, candidate) : workspaceRoot;
  const resolved = await fs.realpath(requested);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("Requested working directory is outside the configured workspace.");
  }
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error("Requested working directory is not a directory.");
  return resolved;
}

function getShell(shell) {
  const isWindows = os.platform() === "win32";
  const selected = String(shell || (isWindows ? "powershell" : "bash")).toLowerCase();
  if (isWindows) {
    if (selected === "powershell") return ["powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]];
    if (selected === "pwsh") return ["pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]];
    if (selected === "cmd") return ["cmd.exe", ["/d", "/s", "/c"]];
  } else {
    if (selected === "bash") return ["bash", ["--noprofile", "--norc", "-c"]];
    if (selected === "sh") return ["sh", ["-c"]];
  }
  throw new Error("Requested shell is unavailable or unsupported on this operating system.");
}

async function approveCommand(operationId, command, cwd, shell) {
  if (!allowRemoteExec || !rl) return false;
  const answer = await rl.question(
    "\nATH IDE local execution request\n" +
    "Operation: " + operationId + "\n" +
    "Shell: " + shell + "\n" +
    "Directory: " + cwd + "\n" +
    "Command:\n" + command + "\n\n" +
    "This runs on THIS computer. Approve this exact command? Type YES: "
  );
  return answer.trim() === "YES";
}

function sendOutput(operationId, data, stream) {
  send("bridge.output", { operationId, data, stream });
}

async function handleCommand(payload) {
  const operationId = String(payload?.operationId || "");
  const command = payload?.command;
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(operationId)) return;
  if (children.has(operationId)) return;
  if (!allowRemoteExec || !rl) {
    send("bridge.completed", { operationId, exitCode: null, rejected: true, reason: "Local remote-execution consent is disabled." });
    return;
  }
  if (typeof command !== "string" || !command.trim() || command.length > MAX_COMMAND_LENGTH ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(command)) {
    send("bridge.completed", { operationId, exitCode: null, rejected: true, reason: "Invalid or oversized command payload." });
    return;
  }

  const now = Date.now();
  while (recentRequests.length && now - recentRequests[0] > 60_000) recentRequests.shift();
  if (recentRequests.length >= MAX_REQUESTS_PER_MINUTE) {
    send("bridge.completed", { operationId, exitCode: null, rejected: true, reason: "Local bridge rate limit exceeded." });
    return;
  }
  if (children.size >= MAX_CONCURRENT_COMMANDS) {
    send("bridge.completed", { operationId, exitCode: null, rejected: true, reason: "Local bridge concurrency limit reached." });
    return;
  }
  recentRequests.push(now);

  let cwd;
  let executable;
  let shellArgs;
  try {
    cwd = await resolveWorkingDirectory(payload.cwd);
    [executable, shellArgs] = getShell(payload.shell);
  } catch (error) {
    send("bridge.completed", { operationId, exitCode: null, rejected: true, reason: error.message });
    return;
  }

  const approved = await approveCommand(operationId, command, cwd, payload.shell || (os.platform() === "win32" ? "powershell" : "bash"));
  if (!approved) {
    send("bridge.completed", { operationId, exitCode: null, rejected: true, reason: "Local user rejected the command." });
    return;
  }

  const child = spawn(executable, [...shellArgs, command], {
    cwd,
    env: minimalEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (children.has(operationId)) child.kill("SIGKILL");
    }, 3000).unref?.();
  }, commandTimeoutMs);
  timer.unref?.();
  children.set(operationId, child);

  child.stdout.on("data", data => sendOutput(operationId, data.toString(), "stdout"));
  child.stderr.on("data", data => sendOutput(operationId, data.toString(), "stderr"));
  child.on("error", error => {
    sendOutput(operationId, error.message, "stderr");
  });
  child.on("close", (exitCode, signal) => {
    clearTimeout(timer);
    children.delete(operationId);
    send("bridge.completed", { operationId, exitCode, signal: signal || null });
  });
}

let socket = null;
let reconnectTimer = null;
let shuttingDown = false;

function stopChildren() {
  for (const child of children.values()) child.kill("SIGTERM");
  children.clear();
}

function connect() {
  if (shuttingDown) return;
  console.log("[+] Connecting to ATH IDE...");
  socket = new WebSocket(wsUrl.toString(), {
    headers: { Authorization: "Bearer " + authToken },
    handshakeTimeout: 15_000,
    maxPayload: 1 * 1024 * 1024,
  });

  socket.on("open", () => {
    send("bridge.register", {
      nodeId: `node_${os.hostname()}_${os.platform()}`,
      name: clientName,
      platform: os.platform(),
      arch: os.arch(),
      runtimes: detectLocalRuntimes(),
      capabilities: allowRemoteExec ? ["exec_local_consent_required"] : ["telemetry"],
    });
    console.log("[+] Registered workstation. Remote execution:", allowRemoteExec ? "enabled with local per-command consent" : "disabled");
  });

  socket.on("message", async raw => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === "bridge.exec") await handleCommand(message.payload || {});
    } catch (error) {
      console.error("[-] Invalid bridge message:", error.message);
    }
  });

  socket.on("close", () => {
    stopChildren();
    if (!shuttingDown) {
      console.log("[-] Disconnected. Reconnecting in 5 seconds...");
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 5000);
    }
  });
  socket.on("error", error => console.error("[-] WebSocket error:", error.message));
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(reconnectTimer);
  stopChildren();
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  rl?.close();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("==========================================================================");
console.log(" ATH IDE -- Hybrid Workstation Bridge");
console.log("==========================================================================");
console.log("[+] Host:", clientName);
console.log("[+] Target:", wsUrl.toString());
console.log("[+] Workspace:", workspaceRoot);
console.log("[+] Remote execution:", allowRemoteExec ? "opt-in; confirmation required per command" : "disabled");
console.log("==========================================================================");

connect();
