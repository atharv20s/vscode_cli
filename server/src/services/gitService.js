/**
 * Git Service
 * 
 * First-class Git version control subsystem executing isolated commands
 * via ExecutionService to inspect repository state, diffs, branches, and commits.
 */

import { config } from "../config/env.js";
import { executionService } from "./executionService.js";

class GitService {
  /**
   * Get parsed repository status.
   */
  async getStatus(cwd = config.workspaceRoot) {
    const branchRes = await executionService.execute({
      command: "git branch --show-current",
      cwd,
      mode: "AGENT_BACKGROUND",
    });

    const statusRes = await executionService.execute({
      command: "git status --porcelain",
      cwd,
      mode: "AGENT_BACKGROUND",
    });

    const branch = branchRes.output.trim() || "HEAD";
    const rawLines = statusRes.output ? statusRes.output.split("\n").filter(Boolean) : [];

    const modified = [];
    const untracked = [];
    const staged = [];
    const deleted = [];

    for (const line of rawLines) {
      const code = line.slice(0, 2);
      const file = line.slice(3).trim();

      if (code.includes("?")) untracked.push(file);
      else if (code.includes("D")) deleted.push(file);
      else if (code.includes("M")) modified.push(file);
      if (code[0] !== " " && code[0] !== "?") staged.push(file);
    }

    return {
      branch,
      dirty: rawLines.length > 0,
      totalChanges: rawLines.length,
      modified,
      untracked,
      staged,
      deleted,
      raw: statusRes.output,
    };
  }

  /**
   * Get diff of unstaged or staged changes.
   */
  async getDiff(staged = false, cwd = config.workspaceRoot) {
    const cmd = staged ? "git diff --staged" : "git diff";
    const res = await executionService.execute({
      command: cmd,
      cwd,
      mode: "AGENT_BACKGROUND",
    });
    return { diff: res.output, success: res.success };
  }

  /**
   * Get recent commit logs.
   */
  async getLog(limit = 10, cwd = config.workspaceRoot) {
    const res = await executionService.execute({
      command: `git log -n ${limit} --oneline`,
      cwd,
      mode: "AGENT_BACKGROUND",
    });
    return { log: res.output, success: res.success };
  }

  /**
   * Commit staged/unstaged changes.
   */
  async commit(message, cwd = config.workspaceRoot) {
    if (!message) throw new Error("Commit message cannot be empty.");
    const escaped = message.replace(/"/g, '\\"');
    const res = await executionService.execute({
      command: `git add . ; git commit -m "${escaped}"`,
      cwd,
      mode: "AGENT_BACKGROUND",
    });
    return { success: res.success, output: res.output };
  }

  /**
   * Push to remote repository.
   */
  async push(remote = "origin", branch = null, cwd = config.workspaceRoot) {
    const cmd = branch ? `git push ${remote} ${branch}` : `git push ${remote}`;
    const res = await executionService.execute({
      command: cmd,
      cwd,
      mode: "AGENT_BACKGROUND",
    });
    return { success: res.success, output: res.output };
  }

  /**
   * Restore a file to a specific commit or HEAD.
   */
  async restoreFile(filePath, commit = "HEAD", cwd = config.workspaceRoot) {
    const res = await executionService.execute({
      command: `git checkout ${commit} -- "${filePath}"`,
      cwd,
      mode: "AGENT_BACKGROUND",
    });
    return { success: res.success, output: res.output };
  }
}

export const gitService = new GitService();
