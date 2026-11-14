import pty from "node-pty";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { config } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { eventBus, EVENT_TOPICS } from "../../websocket/eventBus.js";
import { sendMessage } from "../../websocket/connectionManager.js";
import { buildBubblewrapArgs, makeUnitName, resolveWorkspacePaths } from "./linuxSandboxBackend.js";

const SAFE_ENV = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C.UTF-8",
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
};
const SYSTEM_PATHS = ["/usr", "/usr/local", "/bin", "/sbin", "/lib", "/lib64"];
const ETC_FILES = ["/etc/hosts", "/etc/resolv.conf", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/ld.so.cache", "/etc/ssl/certs/ca-certificates.crt"];

export class LinuxPtyBackend {
  constructor(options = {}) {
    this.ptyImpl = options.ptyImpl || pty;
    this.spawnProcess = options.spawnProcess || spawn;
    this.fsAccess = options.fsAccess || access;
    this.platform = options.platform || process.platform;
    this.ptyProcess = null;
    this.unit = null;
    this.ws = null;
  }

  async spawnShell({ sessionId, workspaceId = "default", workspaceDir, cwd, cols = 80, rows = 24, ws, onExit, onData }) {
    if (this.platform !== "linux") throw new Error("Linux PTY requires a Linux worker host.");
    const { root, workingDirectory } = await resolveWorkspacePaths(workspaceDir, cwd);
    for (const binary of [config.linuxSandbox.systemdRunBinary, config.linuxSandbox.bubblewrapBinary, "/bin/bash"]) {
      if (binary.startsWith("/")) await this.fsAccess(binary).catch(() => { throw new Error("Required Linux sandbox binary is unavailable: " + binary); });
    }
    const availablePaths = async (paths) => {
      const results = await Promise.all(paths.map(async item => {
        try { await this.fsAccess(item); return item; } catch { return null; }
      }));
      return results.filter(Boolean);
    };
    const unit = makeUnitName("pty-" + sessionId);
    const args = [
      "--user", "--scope", "--wait", "--collect", "--quiet",
      "--unit=" + unit,
      "--property=MemoryMax=" + config.linuxSandbox.memoryMax,
      "--property=CPUQuota=" + config.linuxSandbox.cpuQuota,
      "--property=TasksMax=" + config.linuxSandbox.tasksMax,
      "--property=NoNewPrivileges=yes",
      "--property=RestrictSUIDSGID=yes",
      "--property=LockPersonality=yes",
      "--",
      config.linuxSandbox.bubblewrapBinary,
      ...buildBubblewrapArgs({
        workspaceRoot: root,
        workingDirectory,
        command: "",
        networkMode: config.linuxSandbox.networkMode,
        systemPaths: await availablePaths(SYSTEM_PATHS),
        etcFiles: await availablePaths(ETC_FILES),
        interactive: true,
        term: "xterm-256color",
      }),
    ];

    this.ws = ws || null;
    this.unit = unit;
    this.ptyProcess = this.ptyImpl.spawn(config.linuxSandbox.systemdRunBinary, args, {
      name: "xterm-256color",
      cols: Math.max(20, cols || 80),
      rows: Math.max(5, rows || 24),
      cwd: root,
      env: SAFE_ENV,
    });
    this.ptyProcess.onData(data => {
      eventBus.publish(EVENT_TOPICS.TERMINAL_OUTPUT, { data, sessionId, workspaceId }, {
        sessionId, workspaceId, source: "linux_pty", actor: "user",
      });
      if (typeof onData === "function") onData(data);
      else if (this.ws) sendMessage(this.ws, "terminal.output", { text: data, sessionId, source: "linux" });
    });
    this.ptyProcess.onExit(({ exitCode, signal }) => {
      logger.info("Linux PTY session exited", { sessionId, exitCode, signal });
      eventBus.publish(EVENT_TOPICS.TERMINAL_EXIT, { code: exitCode, signal, sessionId, workspaceId }, {
        sessionId, workspaceId, source: "linux_pty", actor: "system",
      });
      onExit?.(exitCode);
      this.ptyProcess = null;
      this.unit = null;
    });
    if (ws) sendMessage(ws, "terminal.output", { text: "[System] Isolated Linux terminal ready\r\n", sessionId });
    return this.ptyProcess;
  }

  attach(ws) { this.ws = ws || null; }
  detach(ws) { if (this.ws === ws) this.ws = null; }
  write(_sessionId, data) { this.ptyProcess?.write(data); }
  resize(_sessionId, cols, rows) {
    try { this.ptyProcess?.resize(Math.max(20, cols), Math.max(5, rows)); } catch {}
  }
  kill(_sessionId) {
    const unit = this.unit;
    try { this.ptyProcess?.kill(); } catch {}
    this.ptyProcess = null;
    this.unit = null;
    if (unit) {
      try {
        const stopper = this.spawnProcess(config.linuxSandbox.systemctlBinary, ["--user", "stop", unit], {
          env: SAFE_ENV, stdio: "ignore", windowsHide: true,
        });
        stopper.once("error", () => {});
      } catch {}
    }
  }
}
