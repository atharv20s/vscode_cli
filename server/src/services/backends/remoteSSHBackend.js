/**
 * Remote SSH Execution Backend & Cloud Shell Provider
 * 
 * Spawns interactive remote PTY sessions over SSH into Google Cloud VMs,
 * AWS EC2, or permanent Linux compute instances, streaming terminal I/O
 * wrapped in standardized event envelopes.
 */

import { spawn, exec } from "child_process";
import pty from "node-pty";
import { logger } from "../../config/logger.js";
import { sendMessage } from "../../websocket/connectionManager.js";
import { eventBus, EVENT_TOPICS } from "../../websocket/eventBus.js";

export class RemoteSSHBackend {
  constructor() {
    this.ptyProcess = null;
    this.hostConfig = null;
  }

  /**
   * Test SSH connectivity to a remote cloud host.
   * 
   * @param {object} params
   * @param {string} params.host - IP address or hostname of the cloud VM
   * @param {number} [params.port=22] - SSH port
   * @param {string} params.username - SSH username
   * @param {string} [params.keyPath] - Path to private SSH key
   * @returns {Promise<{ success: boolean, info?: string, error?: string }>}
   */
  static async testConnection({ host, port = 22, username = "ubuntu", keyPath = null }) {
    return new Promise((resolve) => {
      const keyArg = keyPath ? `-i "${keyPath}"` : "";
      const cmd = `ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=5 ${keyArg} -p ${port} ${username}@${host} "uname -a && uptime"`;

      exec(cmd, { timeout: 8000 }, (err, stdout, stderr) => {
        if (err) {
          resolve({
            success: false,
            error: stderr.trim() || err.message || "Failed to establish SSH connection to remote host.",
          });
        } else {
          resolve({
            success: true,
            info: stdout.trim(),
          });
        }
      });
    });
  }

  /**
   * Spawn a real remote interactive SSH PTY session.
   * 
   * @param {string} sessionId
   * @param {object} options
   * @param {string} options.host - Remote Cloud VM IP / hostname
   * @param {number} [options.port=22] - SSH port
   * @param {string} [options.username='ubuntu'] - SSH user
   * @param {string} [options.keyPath] - Path to SSH key
   * @param {number} [options.cols=120]
   * @param {number} [options.rows=30]
   */
  spawn({
    sessionId,
    host,
    port = 22,
    username = "ubuntu",
    keyPath = null,
    cols = 120,
    rows = 30,
  }) {
    this.hostConfig = { host, port, username, keyPath };

    const sshArgs = [
      "-tt",
      "-o", "StrictHostKeyChecking=no",
      "-p", port.toString(),
    ];

    if (keyPath) {
      sshArgs.push("-i", keyPath);
    }

    sshArgs.push(`${username}@${host}`);

    logger.info(`RemoteSSHBackend: Spawning remote SSH PTY session for ${username}@${host}:${port}`);

    try {
      this.ptyProcess = pty.spawn("ssh", sshArgs, {
        name: "xterm-256color",
        cols,
        rows,
        env: { ...process.env, TERM: "xterm-256color" },
      });

      // Stream data from remote SSH PTY back to frontend
      this.ptyProcess.onData((data) => {
        eventBus.publish(EVENT_TOPICS.TERMINAL_OUTPUT, {
          data,
        }, {
          sessionId,
          source: "terminal",
          actor: "user",
        });

        sendMessage(null, "terminal.output", {
          data,
          sessionId,
          source: "remote_ssh",
          host,
        });
      });

      this.ptyProcess.onExit(({ exitCode, signal }) => {
        logger.info(`RemoteSSHBackend: Remote SSH session ${sessionId} exited (Code: ${exitCode})`);
        eventBus.publish(EVENT_TOPICS.TERMINAL_SESSION_DESTROYED, {
          exitCode,
          signal,
          sessionId,
          host,
        }, {
          sessionId,
          source: "terminal",
          actor: "user",
        });
      });

      return this.ptyProcess;
    } catch (err) {
      logger.error(`RemoteSSHBackend: Failed to spawn remote SSH PTY: ${err.message}`);
      throw err;
    }
  }

  write(data) {
    if (this.ptyProcess) {
      this.ptyProcess.write(data);
    }
  }

  resize(cols, rows) {
    if (this.ptyProcess) {
      try {
        this.ptyProcess.resize(cols, rows);
      } catch { }
    }
  }

  kill() {
    if (this.ptyProcess) {
      try {
        this.ptyProcess.kill();
      } catch { }
      this.ptyProcess = null;
    }
  }
}
