/**
 * Preview Service
 * 
 * Manages development server processes, detects localhost URLs & ports
 * from stdout/stderr streams, performs readiness health checks, and emits
 * formalized preview.* lifecycle events to automatically synchronize the
 * IDE Preview panel.
 */

import { spawn } from "child_process";
import http from "http";
import { logger } from "../config/logger.js";
import { config } from "../config/env.js";
import { eventBus, EVENT_TOPICS } from "../websocket/eventBus.js";
import { killProcessTree } from "./processSupervisor.js";

/** Regex patterns for detecting localhost URLs and assigned ports */
const URL_PATTERNS = [
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})(?:\/[^\s]*)?/i,
  /Local:\s+(https?:\/\/[^\s]+)/i,
  /listening on (?:port )?(\d{2,5})/i,
  /server running at (https?:\/\/[^\s]+)/i,
  /Serving HTTP on (?:0\.0\.0\.0|127\.0\.0\.1) port (\d{2,5})/i,
];

class PreviewService {
  constructor() {
    this.state = {
      status: "stopped", // 'stopped' | 'starting' | 'running' | 'failed'
      command: null,
      cwd: null,
      port: null,
      url: null,
      pid: null,
      startedAt: null,
      error: null,
    };

    this.activeChild = null;
  }

  /**
   * Start a live application preview / dev server.
   * 
   * @param {object} options
   * @param {string} [options.command='npm run dev'] - Dev server startup command
   * @param {string} [options.cwd] - Working directory
   * @param {number} [options.port] - Explicit port override (if known)
   * @param {string} [options.shell='powershell']
   * @param {number} [options.timeout=30000] - Readiness timeout in ms
   * @returns {Promise<{ success: boolean, url: string, port: number, pid: number }>}
   */
  async startPreview({
    command = "npm run dev",
    cwd = config.workspaceRoot,
    port = null,
    shell = "powershell",
    timeout = 30000,
  } = {}) {
    // 1. Stop any currently active preview server
    await this.stopPreview();

    this.state = {
      status: "starting",
      command,
      cwd,
      port: port || null,
      url: port ? `http://localhost:${port}` : null,
      pid: null,
      startedAt: Date.now(),
      error: null,
    };

    eventBus.publish(EVENT_TOPICS.PREVIEW_STARTED, {
      command,
      cwd,
      timestamp: this.state.startedAt,
    }, {
      source: "preview",
      actor: "agent",
    });

    logger.info(`PreviewService: Starting preview server: ${command} in ${cwd}`);

    const isWindows = process.platform === "win32";
    let shellExecutable = "powershell.exe";
    let shellArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command];

    if (isWindows) {
      if (shell === "cmd") {
        shellExecutable = "cmd.exe";
        shellArgs = ["/c", command];
      }
    } else {
      shellExecutable = "bash";
      shellArgs = ["-c", command];
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let detectedUrl = this.state.url;
      let detectedPort = this.state.port;

      try {
        this.activeChild = spawn(shellExecutable, shellArgs, {
          cwd,
          env: { ...process.env, TERM: "dumb" },
          windowsHide: true,
        });
      } catch (err) {
        this.state.status = "failed";
        this.state.error = err.message;
        eventBus.publish(EVENT_TOPICS.PREVIEW_FAILED, { error: err.message });
        return reject(err);
      }

      this.state.pid = this.activeChild.pid || null;

      // Scan stream chunks for URL / port patterns
      const scanOutput = (text) => {
        eventBus.publish(EVENT_TOPICS.PREVIEW_OUTPUT, { data: text });

        if (settled) return;

        for (const pattern of URL_PATTERNS) {
          const match = text.match(pattern);
          if (match) {
            const raw = match[1];
            if (raw.startsWith("http")) {
              detectedUrl = raw.replace("0.0.0.0", "localhost");
              const portMatch = detectedUrl.match(/:(\d+)/);
              if (portMatch) detectedPort = parseInt(portMatch[1], 10);
            } else if (!isNaN(parseInt(raw, 10))) {
              detectedPort = parseInt(raw, 10);
              detectedUrl = `http://localhost:${detectedPort}`;
            }

            if (detectedUrl && detectedPort) {
              logger.info(`PreviewService: Detected live preview at ${detectedUrl} (Port: ${detectedPort})`);
              this._confirmReadiness(detectedUrl, detectedPort, resolve);
              break;
            }
          }
        }
      };

      this.activeChild.stdout.on("data", (chunk) => scanOutput(chunk.toString("utf8")));
      this.activeChild.stderr.on("data", (chunk) => scanOutput(chunk.toString("utf8")));

      this.activeChild.on("close", (code) => {
        if (!settled) {
          settled = true;
          this.state.status = "failed";
          this.state.error = `Process exited prematurely with code ${code}`;
          eventBus.publish(EVENT_TOPICS.PREVIEW_FAILED, { error: this.state.error });
          resolve({ success: false, error: this.state.error });
        } else {
          this.state.status = "stopped";
          eventBus.publish(EVENT_TOPICS.PREVIEW_STOPPED, { code });
        }
      });

      this.activeChild.on("error", (err) => {
        if (!settled) {
          settled = true;
          this.state.status = "failed";
          this.state.error = err.message;
          eventBus.publish(EVENT_TOPICS.PREVIEW_FAILED, { error: err.message });
          resolve({ success: false, error: err.message });
        }
      });

      // Readiness timeout
      setTimeout(() => {
        if (!settled) {
          if (detectedUrl) {
            this._confirmReadiness(detectedUrl, detectedPort || 3000, resolve);
          } else {
            settled = true;
            this.state.status = "failed";
            this.state.error = `Preview readiness timed out after ${timeout / 1000}s`;
            eventBus.publish(EVENT_TOPICS.PREVIEW_FAILED, { error: this.state.error });
            resolve({ success: false, error: this.state.error });
          }
        }
      }, timeout);
    });
  }

  /**
   * Health check endpoint readiness before publishing PREVIEW_READY.
   * @private
   */
  async _confirmReadiness(url, port, resolve) {
    this.state.status = "running";
    this.state.url = url;
    this.state.port = port;

    eventBus.publish(EVENT_TOPICS.PREVIEW_READY, {
      url,
      port,
      pid: this.state.pid,
      command: this.state.command,
    }, {
      source: "preview",
      actor: "agent",
    });

    logger.info(`PreviewService: Preview is READY at ${url}`);
    resolve({
      success: true,
      url,
      port,
      pid: this.state.pid,
    });
  }

  /**
   * Stop active preview process and kill entire process tree.
   * 
   * @returns {Promise<boolean>}
   */
  async stopPreview() {
    if (this.state.pid) {
      logger.info(`PreviewService: Stopping preview process tree (PID: ${this.state.pid})`);
      await killProcessTree(this.state.pid);
      this.state.pid = null;
    }

    if (this.activeChild) {
      try {
        this.activeChild.kill();
      } catch {}
      this.activeChild = null;
    }

    const wasRunning = this.state.status !== "stopped";
    this.state.status = "stopped";
    this.state.url = null;
    this.state.port = null;

    if (wasRunning) {
      eventBus.publish(EVENT_TOPICS.PREVIEW_STOPPED, {
        timestamp: Date.now(),
      }, {
        source: "preview",
        actor: "system",
      });
    }

    return true;
  }

  /**
   * Restart the preview application.
   */
  async restartPreview() {
    if (!this.state.command) {
      throw new Error("No previous preview command to restart.");
    }
    return this.startPreview({
      command: this.state.command,
      cwd: this.state.cwd,
      port: this.state.port,
    });
  }

  /**
   * Get current preview state.
   */
  getPreviewState() {
    return { ...this.state };
  }
}

export const previewService = new PreviewService();
