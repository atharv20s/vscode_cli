/**
 * Docker-backed interactive terminal for one isolated user workspace.
 */
import pty from "node-pty";
import { config } from "../../config/env.js";
import { dockerWorkspaceRuntime } from "../dockerWorkspaceRuntime.js";
import { sendMessage } from "../../websocket/connectionManager.js";

export class DockerBackend {
  constructor() { this.ptyProcess = null; this.ws = null; this.onData = null; }

  async spawnShell({ sessionId, workspaceId, workspaceDir, cols = 80, rows = 24, ws, onExit, onData }) {
    this.ws = ws || null;
    this.onData = typeof onData === "function" ? onData : null;
    const name = await dockerWorkspaceRuntime.ensureContainer(workspaceId, workspaceDir);
    this.ptyProcess = pty.spawn(config.dockerBinary, [
      "exec", "-it", "-w", "/workspace", name, "/bin/bash", "-l",
    ], {
      name: "xterm-256color", cols, rows,
      env: { ...process.env, TERM: "xterm-256color" },
    });
    this.ptyProcess.onData(data => {
      if (this.ws) sendMessage(this.ws, "terminal.output", { data, sessionId, source: "docker" });
    });
    this.ptyProcess.onExit(({ exitCode }) => onExit?.(exitCode));
    return this.ptyProcess;
  }

  attach(ws) { this.ws = ws || null; }
  detach(ws) { if (this.ws === ws) this.ws = null; }
  write(_sessionId, data) { this.ptyProcess?.write(data); }
  resize(_sessionId, cols, rows) { try { this.ptyProcess?.resize(cols, rows); } catch {} }
  kill(_sessionId) { try { this.ptyProcess?.kill(); } catch {} this.ptyProcess = null; }
}