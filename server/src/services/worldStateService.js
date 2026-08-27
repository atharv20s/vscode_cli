/**
 * Central World State Service — Aggregated Environmental Awareness
 * 
 * Aggregates live state across all subsystems (Workspace, Terminal, Processes,
 * Preview, Git, GitHub, MCP, and Permissions) into a single unified snapshot,
 * eliminating the need for the agent to rediscover reality on each turn.
 */

import path from "path";
import { config } from "../config/env.js";
import { eventBus } from "../websocket/eventBus.js";
import { terminalContextService } from "./terminalContextService.js";
import { previewService } from "./previewService.js";
import { processSupervisor } from "./processSupervisor.js";
import { permissionEngine } from "./permissionEngine.js";
import { gitService } from "./gitService.js";

class WorldStateService {
  constructor() {
    this.state = {
      workspace: {
        root: config.workspaceRoot,
        name: path.basename(config.workspaceRoot),
        treeVersion: 1,
      },
      git: {
        branch: "main",
        dirty: false,
        totalChanges: 0,
        modified: [],
        staged: [],
      },
      github: {
        authenticated: false,
        user: null,
        repository: null,
      },
      mcp: {
        servers: ["filesystem"],
        activeToolsCount: 14,
      },
    };

    this._isPollingGit = false;
    this._gitPollDebounce = null;

    this._setupListeners();
    // Non-blocking initial git poll after startup
    setTimeout(() => this._pollGitState(), 1000);
  }

  /**
   * Subscribe to the central EventBus to maintain live world state.
   * @private
   */
  _setupListeners() {
    eventBus.subscribe("*", (envelope) => {
      const { type, source } = envelope;

      // 1. Filesystem Events
      if (type.startsWith("file.")) {
        this.state.workspace.treeVersion++;
        this._scheduleGitPoll();
      }

      // 2. Completed Non-Git Agent Commands
      if (type === "agent.command.completed" && source !== "gitService") {
        this._scheduleGitPoll();
      }
    });
  }

  /**
   * Debounced Git state poller to prevent high-frequency re-polling.
   * @private
   */
  _scheduleGitPoll() {
    clearTimeout(this._gitPollDebounce);
    this._gitPollDebounce = setTimeout(() => {
      this._pollGitState();
    }, 500);
  }

  /**
   * Poll Git status safely without recursive loops.
   * @private
   */
  async _pollGitState() {
    if (this._isPollingGit) return;
    this._isPollingGit = true;

    try {
      const status = await gitService.getStatus();
      this.state.git = {
        branch: status.branch,
        dirty: status.dirty,
        totalChanges: status.totalChanges,
        modified: status.modified,
        staged: status.staged,
      };
    } catch {
      // Ignored if git is not initialized in workspace
    } finally {
      this._isPollingGit = false;
    }
  }

  /**
   * Retrieve the complete structured World State formatted for the LLM prompt.
   * 
   * @param {string} [sessionId]
   * @returns {object} Full environmental snapshot
   */
  getWorldState(sessionId = null) {
    const termCtx = terminalContextService.getStructuredContext(sessionId);
    const previewCtx = previewService.getPreviewState();
    const activeProcs = processSupervisor.listActiveProcesses();
    const pendingPerms = permissionEngine.listPendingRequests();

    return {
      workspace: {
        root: this.state.workspace.root,
        name: this.state.workspace.name,
        tree_version: this.state.workspace.treeVersion,
      },
      terminal: {
        sessionId: termCtx.sessionId,
        shell: termCtx.shell,
        cwd: termCtx.cwd,
        state: termCtx.state,
        active_process: termCtx.activeProcess,
        detected_ports: termCtx.detectedPorts,
        last_command: termCtx.lastCommand,
        last_command_time: termCtx.lastCommandTimeAgo,
        exit_code: termCtx.exitCode,
        recent_output: termCtx.recentOutputTail,
        recent_errors: termCtx.recentErrors,
      },
      preview: {
        status: previewCtx.status,
        command: previewCtx.command,
        port: previewCtx.port,
        url: previewCtx.url,
        pid: previewCtx.pid,
      },
      git: this.state.git,
      github: this.state.github,
      mcp: this.state.mcp,
      supervised_processes: {
        active_count: activeProcs.length,
        tasks: activeProcs.map((p) => ({ operationId: p.operationId, command: p.command, pid: p.pid })),
      },
      permissions: {
        pending_requests_count: pendingPerms.length,
      },
    };
  }
}

export const worldStateService = new WorldStateService();
