/**
 * Git worktree isolation for repository agents.
 *
 * Worktrees are created beneath the task's mounted workspace and all Git
 * commands execute inside that workspace's isolated Docker container.
 */
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { dockerWorkspaceRuntime } from "./dockerWorkspaceRuntime.js";

export function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

export function assertSafeId(value, label) {
  const id = String(value || "");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    throw new Error(label + " must contain only letters, numbers, underscores or hyphens.");
  }
  return id;
}

export class WorktreeManager {
  constructor(options = {}) {
    this.directoryName = options.directoryName || ".ath-worktrees";
  }

  async execute({ workspaceDir, workspaceId, command, signal, timeout = 60000 }) {
    const result = await dockerWorkspaceRuntime.execute({
      workspaceId, workspaceDir, cwd: workspaceDir, command, signal, timeout,
    });
    if (!result.success) {
      throw new Error("Git worktree command failed (" + result.exitCode + "): " + String(result.output || "").slice(-5000));
    }
    return result.output || "";
  }

  async createWorktree({ workspaceDir, workspaceId, taskId, baseRef = "HEAD", signal }) {
    if (!path.isAbsolute(workspaceDir) || !workspaceId) {
      throw new Error("An absolute task workspace and workspace identity are required.");
    }
    const safeTaskId = assertSafeId(taskId, "Task id");
    if (!/^(HEAD|[a-zA-Z0-9_./-]{1,128})$/.test(String(baseRef))) {
      throw new Error("Invalid worktree base ref.");
    }
    const root = await fs.realpath(workspaceDir);
    const worktreeRoot = path.join(root, this.directoryName);
    const worktreeName = safeTaskId + "-" + crypto.randomUUID().slice(0, 8);\n    const worktreePath = path.join(worktreeRoot, worktreeName);\n    const containerWorktreePath = path.posix.join("/workspace", this.directoryName, worktreeName);
    const branch = "ath-agent/" + safeTaskId + "-" + crypto.randomUUID().slice(0, 8);
    await fs.mkdir(worktreeRoot, { recursive: true, mode: 0o700 });

    await this.execute({
      workspaceDir: root, workspaceId, signal,
      command: "git rev-parse --is-inside-work-tree",
    });
    await this.execute({
      workspaceDir: root, workspaceId, signal,
      command: "git worktree add -b " + shellQuote(branch) + " " + shellQuote(containerWorktreePath) + " " + shellQuote(baseRef),
    });
    return { workspaceDir: root, workspaceId, worktreePath, containerWorktreePath, branch, taskId: safeTaskId };
  }

  async commitWorktree(worktree, message, signal) {
    const { workspaceDir, workspaceId, worktreePath, containerWorktreePath, branch } = worktree || {};
    if (!workspaceDir || !workspaceId || !worktreePath || !branch) {
      throw new Error("A complete worktree descriptor is required.");
    }
    const relative = path.relative(workspaceDir, worktreePath);
    if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      throw new Error("Worktree path must be inside its parent workspace.");
    }
    const command = [
      "git -C " + shellQuote(containerWorktreePath) + " diff --check",
      "git -C " + shellQuote(containerWorktreePath) + " add -A",
      "git -C " + shellQuote(containerWorktreePath) + " -c user.name='ATH IDE Agent' -c user.email='ath-ide-agent@localhost' commit --allow-empty -m " + shellQuote(String(message || "Implement isolated agent task").slice(0, 200)),
      "git -C " + shellQuote(containerWorktreePath) + " rev-parse HEAD",
    ].join(" && ");
    const output = await this.execute({ workspaceDir, workspaceId, command, signal });
    const commit = output.trim().split(/\s+/).at(-1);
    if (!/^[a-f0-9]{40,64}$/i.test(commit || "")) {
      throw new Error("Git did not return a valid worktree commit.");
    }
    return { ...worktree, commit };
  }

  async mergeWorktree(worktree, signal) {
    const { workspaceDir, workspaceId, branch, containerWorktreePath } = worktree || {};
    assertSafeId(String(branch || "").replace(/^ath-agent\//, ""), "Worktree branch suffix");
    if (!String(branch).startsWith("ath-agent/")) throw new Error("Only ATH IDE agent branches may be merged.");
    const output = await this.execute({
      workspaceDir, workspaceId, signal,
      command: "git merge --no-ff --no-edit " + shellQuote(branch),
      timeout: 120000,
    });
    return { success: true, output };
  }

  async removeWorktree(worktree, options = {}) {
    const { workspaceDir, workspaceId, worktreePath, containerWorktreePath, branch } = worktree || {};
    if (!workspaceDir || !workspaceId || !worktreePath) return false;
    const relative = path.relative(workspaceDir, worktreePath);
    if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      throw new Error("Refusing to remove a worktree outside its parent workspace.");
    }
    const branchDelete = options.deleteBranch && branch && String(branch).startsWith("ath-agent/")
      ? " && git branch -D " + shellQuote(branch)
      : "";
    await this.execute({
      workspaceDir, workspaceId,
      command: "git worktree remove --force " + shellQuote(containerWorktreePath) + branchDelete + " && git worktree prune",
    });
    return true;
  }

  async listWorktrees({ workspaceDir, workspaceId, signal }) {
    return this.execute({ workspaceDir, workspaceId, signal, command: "git worktree list --porcelain" });
  }
}

export const worktreeManager = new WorktreeManager();
