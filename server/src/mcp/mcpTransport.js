/**
 * MCP Transport Layer — JSON-RPC 2.0 over a child process stdio channel.
 */
import { spawn } from "child_process";
import { EventEmitter } from "events";
import { logger } from "../config/logger.js";

const INHERITED_ENV_KEYS = ["PATH", "Path", "HOME", "USERPROFILE", "TEMP", "TMP", "SystemRoot", "WINDIR", "LANG", "LC_ALL", "NODE_ENV"];

/** MCP children inherit only runtime variables; secrets must be passed explicitly. */
export function buildMcpProcessEnv(configured = {}, source = process.env) {
  const result = {};
  for (const key of INHERITED_ENV_KEYS) if (typeof source[key] === "string") result[key] = source[key];
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) return result;
  for (const [key, value] of Object.entries(configured)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.length > 4096) throw new Error(`Invalid MCP environment entry: ${key}`);
    result[key] = value;
  }
  return result;
}

export function jsonrpcRequest(method, params, id) {
  return JSON.stringify({ jsonrpc: "2.0", method, params: params || {}, id });
}

export function jsonrpcNotification(method, params) {
  return JSON.stringify({ jsonrpc: "2.0", method, params: params || {} });
}

export class StdioTransport extends EventEmitter {
  constructor(command, args = [], env = {}) {
    super();
    this.command = command;
    this.args = args;
    this.env = env;
    this.process = null;
    this._buffer = "";
    this._requestId = 0;
    this._pendingRequests = new Map();
    this._connected = false;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(this.command, this.args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: buildMcpProcessEnv(this.env),
          shell: false,
          windowsHide: true,
        });
        let settled = false;
        const startupTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          this._connected = true;
          resolve();
        }, 250);
        this.process.stdout.on("data", data => this._handleData(data.toString()));
        this.process.stderr.on("data", data => logger.warn(`MCP server stderr: ${data.toString().trim().slice(0, 2000)}`));
        this.process.on("error", err => {
          logger.error(`MCP process error: ${err.message}`);
          this.emit("error", err);
          if (!settled) {
            settled = true;
            clearTimeout(startupTimer);
            reject(err);
          }
          this._failPending(err);
        });
        this.process.on("exit", code => {
          logger.info(`MCP process exited with code ${code}`);
          this._connected = false;
          this._failPending(new Error(`MCP server exited with code ${code}`));
          this.emit("close", code);
          if (!settled) {
            settled = true;
            clearTimeout(startupTimer);
            reject(new Error(`MCP server exited during startup (code ${code})`));
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  _failPending(error) {
    for (const [id, pending] of this._pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this._pendingRequests.delete(id);
    }
  }

  async request(method, params, timeoutMs = 30_000) {
    if (!this.isConnected) throw new Error("MCP server is not connected.");
    const id = ++this._requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);
      this._pendingRequests.set(id, { resolve, reject, timer });
      this.process.stdin.write(jsonrpcRequest(method, params, id) + "\n", error => {
        if (!error) return;
        clearTimeout(timer);
        this._pendingRequests.delete(id);
        reject(error);
      });
    });
  }

  notify(method, params) {
    if (!this.isConnected) throw new Error("MCP server is not connected.");
    this.process.stdin.write(jsonrpcNotification(method, params) + "\n");
  }

  _handleData(data) {
    this._buffer += data;
    if (this._buffer.length > 4 * 1024 * 1024) {
      this._buffer = "";
      this.emit("error", new Error("MCP message buffer exceeded 4 MiB."));
      return;
    }
    const lines = this._buffer.split("\n");
    this._buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { this._handleMessage(JSON.parse(trimmed)); }
      catch { logger.warn(`Failed to parse MCP message: ${trimmed.slice(0, 200)}`); }
    }
  }

  _handleMessage(msg) {
    if (msg.id !== undefined && this._pendingRequests.has(msg.id)) {
      const { resolve, reject, timer } = this._pendingRequests.get(msg.id);
      clearTimeout(timer);
      this._pendingRequests.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || "MCP error"));
      else resolve(msg.result);
      return;
    }
    if (msg.method) this.emit("notification", { method: msg.method, params: msg.params });
  }

  async disconnect() {
    if (!this.process) return;
    const child = this.process;
    this.process = null;
    this._connected = false;
    this._failPending(new Error("MCP server disconnected."));
    child.kill("SIGTERM");
  }

  get isConnected() {
    return Boolean(this._connected && this.process && !this.process.killed);
  }
}
