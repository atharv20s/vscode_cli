/**
 * Worktree Manager — Git Worktree Isolation
 * 
 * Provides concurrent agent execution environments by spawning dedicated
 * Git worktrees (.worktrees/agent-<id>), isolating file modifications
 * from the user's primary working tree until merged or approved.
 */

import path from "path";
import fs from "fs/promises";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import { executionService } from "./executionService.js";

class WorktreeManager {
  constructor() {
    this.baseWorktreeDir = path.join(config.workspaceRoot, ".worktrees");
  }

  /**
   * Create an isolated Git worktree for an agent conversation/turn.
   * 
   * @param {string} conversationId
   * @param {string} [branch]
   * @returns {Promise<{ worktreePath: string, branch: string }>}
   */
  async createWorktree(conversationId, branch = null) {
    const branchName = branch || `agent-${conversationId.slice(0, 8)}`;
    const worktreePath = path.join(this.baseWorktreeDir, `agent-${conversationId}`);

    await fs.mkdir(this.baseWorktreeDir, { recursive: true });

    logger.info(`WorktreeManager: Creating worktree at ${worktreePath} on branch ${branchName}`);

    const res = await executionService.execute({
      command: `git worktree add -b ${branchName} "${worktreePath}"`,
      cwd: config.workspaceRoot,
      mode: "AGENT_BACKGROUND",
    });

    if (!res.success) {
      // Fallback if branch exists already
      await executionService.execute({
        command: `git worktree add "${worktreePath}" ${branchName}`,
        cwd: config.workspaceRoot,
        mode: "AGENT_BACKGROUND",
      });
    }

    return { worktreePath, branch: branchName };
  }

  /**
   * Remove and clean up an agent worktree.
   * 
   * @param {string} conversationId
   * @returns {Promise<boolean>}
   */
  async removeWorktree(conversationId) {
    const worktreePath = path.join(this.baseWorktreeDir, `agent-${conversationId}`);
    logger.info(`WorktreeManager: Removing worktree at ${worktreePath}`);

    const res = await executionService.execute({
      command: `git worktree remove --force "${worktreePath}"`,
      cwd: config.workspaceRoot,
      mode: "AGENT_BACKGROUND",
    });

    return res.success;
  }

  /**
   * List active git worktrees.
   */
  async listWorktrees() {
    const res = await executionService.execute({
      command: "git worktree list",
      cwd: config.workspaceRoot,
      mode: "AGENT_BACKGROUND",
    });
    return res.output;
  }
}

export const worktreeManager = new WorktreeManager();
