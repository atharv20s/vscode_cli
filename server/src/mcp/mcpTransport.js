/**
 * MCP Transport Layer — Communication abstractions for MCP.
 *
 * Implements JSON-RPC 2.0 message framing over:
 * - stdio (for local MCP servers)
 * - HTTP+SSE (for remote MCP servers — future)
 */

import { spawn } from "child_process";
import { EventEmitter } from "events";
import { logger } from "../config/logger.js";

/**
 * JSON-RPC 2.0 message builder.
 */
export function jsonrpcRequest(method, params, id) {
  return JSON.stringify({
    jsonrpc: "2.0",
    method,
    params: params || {},
    id,
  });
}

export function jsonrpcNotification(method, params) {
  return JSON.stringify({
    jsonrpc: "2.0",
    method,
    params: params || {},
  });
}

/**
 * StdioTransport — Communicates with MCP servers via stdin/stdout.
 *
 * The MCP server is a child process. We write JSON-RPC messages to its stdin
 * and read responses from its stdout, separated by newlines.
 */
export class StdioTransport extends EventEmitter {
  /**
   * @param {string} command - Command to spawn
   * @param {string[]} args - Command arguments
   * @param {object} [env] - Additional environment variables
   */
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

  /**
   * Start the MCP server process.
   */
  async connect() {
    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(this.command, this.args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, ...this.env },
          shell: true,
        });

        this.process.stdout.on("data", (data) => {
          this._handleData(data.toString());
        });

        this.process.stderr.on("data", (data) => {
          logger.warn(`MCP server stderr: ${data.toString().trim()}`);
        });

        this.process.on("error", (err) => {
          logger.error(`MCP process error: ${err.message}`);
          this.emit("error", err);
          if (!this._connected) reject(err);
        });

        this.process.on("exit", (code) => {
          logger.info(`MCP process exited with code ${code}`);
          this._connected = false;
          this.emit("close", code);
        });

        // Give it a moment to start
        setTimeout(() => {
          this._connected = true;
          resolve();
        }, 500);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Send a JSON-RPC request and wait for a response.
   */
  async request(method, params, timeoutMs = 30000) {
    const id = ++this._requestId;
    const message = jsonrpcRequest(method, params, id);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);

      this._pendingRequests.set(id, { resolve, reject, timer });

      this.process.stdin.write(message + "\n");
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  notify(method, params) {
    const message = jsonrpcNotification(method, params);
    this.process.stdin.write(message + "\n");
  }

  /**
   * Handle incoming data from stdout.
   */
  _handleData(data) {
    this._buffer += data;

    // Split by newlines — each line is a complete JSON-RPC message
    const lines = this._buffer.split("\n");
    this._buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed);
        this._handleMessage(msg);
      } catch (err) {
        logger.warn(`Failed to parse MCP message: ${trimmed.slice(0, 200)}`);
      }
    }
  }

  /**
   * Handle a parsed JSON-RPC message.
   */
  _handleMessage(msg) {
    // Response to a request
    if (msg.id !== undefined && this._pendingRequests.has(msg.id)) {
      const { resolve, reject, timer } = this._pendingRequests.get(msg.id);
      clearTimeout(timer);
      this._pendingRequests.delete(msg.id);

      if (msg.error) {
        reject(new Error(msg.error.message || "MCP error"));
      } else {
        resolve(msg.result);
      }
      return;
    }

    // Server-initiated notification
    if (msg.method) {
      this.emit("notification", { method: msg.method, params: msg.params });
      return;
    }
  }

  /**
   * Disconnect — kill the child process.
   */
  async disconnect() {
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
      this._connected = false;
    }
  }

  get isConnected() {
    return this._connected && this.process && !this.process.killed;
  }
}
