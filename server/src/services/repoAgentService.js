/**
 * Repository Agent Service
 *
 * Each task clones one authorized GitHub repository into a task-specific
 * workspace and runs the coding agent only inside that workspace's Docker
 * container. The GitHub token is used by this host-side service for Git/API
 * access only; it is never mounted into the execution container or agent tools.
 */
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { getDatabase } from "../db/database.js";
import {
  countActiveRepoTasks, createRepoTask, getRepoTask, listRepoTasks,
  updateRepoTask, appendRepoTaskEvent, getRepoTaskGithubToken,
} from "../db/repoAgentStore.js";
import { repoAgentQueue } from "./repoAgentQueue.js";
import { runRepoAgentPipeline } from "./repoAgentPipeline.js";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import { getWorkspaceService, createScopedWorkspaceService } from "./workspaceService.js";
import { dockerWorkspaceRuntime } from "./dockerWorkspaceRuntime.js";
import { runAgent } from "./agentService.js";
import { getOctokit } from "./githubService.js";

const MAX_TREE_ENTRIES = 25000;
const MAX_CHANGED_FILES = 200;
const MAX_CHANGED_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CHANGED_BYTES = 12 * 1024 * 1024;
const MAX_SCAN_BYTES = 150 * 1024 * 1024;
const MAX_ACTIVE_TASKS_PER_USER = 2;
const IGNORED_DIRS = new Set([
  ".git", "node_modules", ".next", "dist", "build", "coverage",
  ".cache", ".worktrees", ".agent-runs",
]);
const SENSITIVE_FILE = /(^|\/)(\.env(?!\.(example|sample|template)$)[^/]*|\.npmrc|\.pypirc|\.netrc|id_rsa|id_ed25519)(\/|$)|\.(pem|key|p12|pfx)$/i;

const REPO_AGENT_TOOLS = [
  "read_file", "write_file", "edit_file", "list_files",
  "run_command", "create_plan", "update_plan",
  "generate_readme", "generate_walkthrough", "generate_uml_diagram",
];
const activeTasks = new Map();

function publicTask(row) {
  if (!row) return null;
  let events = [];
  try { events = Array.isArray(row.events_json) ? row.events_json : JSON.parse(row.events_json || "[]"); } catch {}
  return {
    id: row.id,
    owner: row.owner,
    repo: row.repo,
    baseBranch: row.base_branch,
    branch: row.branch,
    prompt: row.prompt,
    status: row.status,
    events,
    pullRequest: row.pr_url ? { url: row.pr_url, number: row.pr_number } : null,
    error: row.error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function rowForUser(userId, taskId) {
  return getRepoTask(taskId, userId);
}

async function patchTask(userId, taskId, patch) {
  const row = await getRepoTask(taskId, userId);
  if (!row) return;
  await updateRepoTask(taskId, patch);
}

async function appendEvent(userId, taskId, event) {
  const row = await getRepoTask(taskId, userId);
  if (!row) return;
  await appendRepoTaskEvent(taskId, event);
}

function runProcess(executable, args, options) {
  const cwd = options.cwd;
  const env = options.env || process.env;
  const timeout = options.timeout || 120000;
  const maxOutput = options.maxOutput || 1024 * 1024;

  return new Promise(function (resolve, reject) {
    const child = spawn(executable, args, {
      cwd: cwd,
      env: env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const finish = function (fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(function () {
      child.kill("SIGKILL");
      finish(reject, new Error(executable + " timed out after " + timeout + "ms"));
    }, timeout);
    const collect = function (chunk) {
      output += chunk.toString("utf8");
      if (output.length > maxOutput) output = output.slice(-maxOutput);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", function (error) { finish(reject, error); });
    child.on("close", function (code) {
      if (code === 0) finish(resolve, output.trim());
      else finish(reject, new Error(executable + " exited with code " + code + ": " + output.trim().slice(-4000)));
    });
  });
}

function gitAuthEnvironment(token) {
  const basic = Buffer.from("x-access-token:" + token, "utf8").toString("base64");
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic " + basic,
  };
}

async function cloneRepository(token, owner, repo, baseBranch, repoPath, parentDir) {
  const env = gitAuthEnvironment(token);
  const url = "https://github.com/" + owner + "/" + repo + ".git";
  await runProcess("git", [
    "clone", "--depth", "1", "--single-branch", "--no-tags",
    "--branch", baseBranch, "--", url, repoPath,
  ], { cwd: parentDir, env: env, timeout: 180000 });
}

function gitBlobSha(buffer) {
  const header = Buffer.from("blob " + buffer.length + "\0", "utf8");
  return crypto.createHash("sha1").update(Buffer.concat([header, buffer])).digest("hex");
}

function ignored(relativePath) {
  return relativePath.split("/").some(function (part) { return IGNORED_DIRS.has(part); });
}

function sensitive(relativePath) {
  return SENSITIVE_FILE.test(relativePath);
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

async function removeProtectedFiles(repoPath, protectedPaths) {
  for (const relative of protectedPaths) {
    const segments = relative.split("/");
    let parent = repoPath;
    let safeParent = true;
    for (const segment of segments.slice(0, -1)) {
      parent = path.join(parent, segment);
      try {
        const stat = await fs.lstat(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink()) { safeParent = false; break; }
      } catch (error) {
        if (error.code === "ENOENT") safeParent = false; else throw error;
        break;
      }
    }
    if (!safeParent) continue;
    const target = path.join(parent, segments[segments.length - 1]);
    if (!inside(repoPath, target)) throw new Error("Protected path escaped repository root.");
    try {
      const stat = await fs.lstat(target);
      if (stat.isFile() || stat.isSymbolicLink()) await fs.unlink(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function scanWorkspace(repoPath, baseEntries) {
  const current = new Map();
  let scannedBytes = 0;

  async function walk(directory, prefix) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!prefix && entry.name === ".git") continue;
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      const relative = prefix ? prefix + "/" + entry.name : entry.name;
      if (ignored(relative)) continue;
      const absolute = path.join(directory, entry.name);
      if (!inside(repoPath, absolute)) throw new Error("Workspace path escaped repository root.");

      const stat = await fs.lstat(absolute);
      if (stat.isDirectory()) {
        await walk(absolute, relative);
      } else if (stat.isSymbolicLink()) {
        const link = await fs.readlink(absolute);
        const resolvedTarget = path.resolve(path.dirname(absolute), link);
        if (!inside(repoPath, resolvedTarget)) {
          throw new Error("Agent created an external symlink at " + relative + "; refusing to publish it.");
        }
        const buffer = Buffer.from(link.replace(/\\/g, "/"), "utf8");
        scannedBytes += buffer.length;
        current.set(relative, { buffer: buffer, mode: "120000", sha: gitBlobSha(buffer) });
      } else if (stat.isFile()) {
        scannedBytes += stat.size;
        if (scannedBytes > MAX_SCAN_BYTES) {
          throw new Error("Repository scan exceeded 150 MiB; remove generated artifacts before creating a PR.");
        }
        const buffer = await fs.readFile(absolute);
        current.set(relative, {
          buffer: buffer,
          mode: (stat.mode & 0o111) ? "100755" : "100644",
          sha: gitBlobSha(buffer),
        });
      }
    }
  }

  await walk(repoPath, "");
  const changes = [];

  for (const pair of current.entries()) {
    const relative = pair[0];
    const item = pair[1];
    const base = baseEntries.get(relative);
    if (base && base.sha === item.sha) continue;
    if (sensitive(relative)) {
      throw new Error("Refusing to include a sensitive file in the PR: " + relative);
    }
    if (item.buffer.length > MAX_CHANGED_FILE_BYTES) {
      throw new Error("Changed file " + relative + " exceeds the 2 MiB per-file publishing limit.");
    }
    changes.push({ path: relative, mode: base?.mode || item.mode, type: "blob", content: item.buffer });
  }

  for (const pair of baseEntries.entries()) {
    const relative = pair[0];
    const base = pair[1];
    if (ignored(relative) || current.has(relative)) continue;
    if (sensitive(relative)) {
      throw new Error("Refusing to delete a sensitive file in the PR: " + relative);
    }
    changes.push({ path: relative, mode: base.mode || "100644", type: "blob", sha: null });
  }

  if (changes.length > MAX_CHANGED_FILES) {
    throw new Error("Agent changed " + changes.length + " files; limit is " + MAX_CHANGED_FILES + ".");
  }
  const changedBytes = changes.reduce(function (sum, item) {
    return sum + (item.content ? item.content.length : 0);
  }, 0);
  if (changedBytes > MAX_CHANGED_BYTES) {
    throw new Error("Total changed content exceeds the 12 MiB GitHub publishing limit.");
  }
  return changes;
}

async function publishDraftPullRequest(options) {
  const octokit = options.octokit;
  const owner = options.owner;
  const repo = options.repo;
  const task = options.task;
  const tree = [];

  for (const change of options.changes) {
    if (change.sha === null) {
      tree.push({ path: change.path, mode: change.mode, type: "blob", sha: null });
      continue;
    }
    const blob = await octokit.git.createBlob({
      owner: owner,
      repo: repo,
      content: change.content.toString("base64"),
      encoding: "base64",
    });
    tree.push({
      path: change.path,
      mode: change.mode,
      type: "blob",
      sha: blob.data.sha,
    });
  }

  const createdTree = await octokit.git.createTree({
    owner: owner,
    repo: repo,
    base_tree: options.baseTreeSha,
    tree: tree,
  });
  const commit = await octokit.git.createCommit({
    owner: owner,
    repo: repo,
    message: "ATH IDE: " + task.prompt.slice(0, 65).replace(/\s+/g, " "),
    tree: createdTree.data.sha,
    parents: [options.baseSha],
  });
  await octokit.git.createRef({
    owner: owner,
    repo: repo,
    ref: "refs/heads/" + task.branch,
    sha: commit.data.sha,
  });

  const body = [
    "## Agent summary",
    options.summary || "The ATH IDE repository agent completed the requested task.",
    "",
    "## Task",
    task.prompt,
    "",
    "## Verification",
    "- Changes were produced in a dedicated task workspace.",
    "- This pull request is a draft; no merge was performed.",
    "- Review the diff and required CI checks before marking it ready.",
  ].join("\n");

  const pr = await octokit.pulls.create({
    owner: owner,
    repo: repo,
    title: "ATH IDE: " + task.prompt.slice(0, 100),
    head: task.branch,
    base: task.baseBranch,
    body: body,
    draft: true,
    maintainer_can_modify: false,
  });
  return { url: pr.data.html_url, number: pr.data.number, commitSha: commit.data.sha };
}

async function executeTask(task, token, octokit, baseTreeSha, baseEntries, protectedPaths, signal = null) {
  const userId = task.user_id;
  const taskId = task.id;
  const repoPath = task.workspace_path;
  const taskDir = path.dirname(repoPath);
  const workspaceId = "repo-agent-" + taskId;
  const abortSignal = signal || activeTasks.get(taskId)?.abort?.signal || new AbortController().signal;
  activeTasks.set(taskId, { userId: userId, abort: activeTasks.get(taskId)?.abort || null, workspaceId: workspaceId });

  try {
    await patchTask(userId, taskId, { status: "cloning" });
    await appendEvent(userId, taskId, {
      type: "status",
      data: { status: "cloning", message: "Cloning " + task.owner + "/" + task.repo },
    });
    await fs.mkdir(taskDir, { recursive: true, mode: 0o700 });
    await cloneRepository(token, task.owner, task.repo, task.base_branch, repoPath, taskDir);

    if (abortSignal.aborted) {
      await patchTask(userId, taskId, { status: "cancelled" });
      await appendEvent(userId, taskId, { type: "status", data: { status: "cancelled" } });
      return;
    }

    const gitEnv = gitAuthEnvironment(token);
    const clonedSha = await runProcess("git", ["rev-parse", "HEAD"], { cwd: repoPath, env: gitEnv });
    if (clonedSha !== task.base_sha) {
      await runProcess("git", ["fetch", "--depth=1", "origin", task.base_sha], {
        cwd: repoPath, env: gitEnv, timeout: 120000,
      });
      await runProcess("git", ["checkout", "--detach", task.base_sha], { cwd: repoPath, env: gitEnv });
    }

    // Remove tracked secrets only after pinning the checkout to the selected base SHA.
    await removeProtectedFiles(repoPath, protectedPaths);

    // Publishing happens through GitHub's API. The agent does not need Git metadata.
    await fs.rm(path.join(repoPath, ".git"), { recursive: true, force: true });

    const workspaceService = createScopedWorkspaceService(repoPath, workspaceId);
    // No local fallback: task code only runs when Docker isolation is available.
    await dockerWorkspaceRuntime.ensureContainer(workspaceId, repoPath, { network: "none" });
    await patchTask(userId, taskId, { status: "running" });
    await appendEvent(userId, taskId, {
      type: "status",
      data: { status: "running", message: "Agent pipeline is running in the dedicated Docker workspace." },
    });

    const pipelineResult = await runRepoAgentPipeline({
      task: task,
      workspaceDir: repoPath,
      workspaceId: workspaceId,
      workspaceService: workspaceService,
      signal: abortSignal,
      onEvent: function (event) {
        appendEvent(userId, taskId, event).catch(error => {
          logger.warn("Unable to persist repository-agent event", { taskId: taskId, error: error.message });
        });
      },
      setStatus: async function (status) {
        await patchTask(userId, taskId, { status: status });
        await appendEvent(userId, taskId, {
          type: "status",
          data: { status: status, message: "Pipeline stage: " + status },
        });
      },
    });

    if (abortSignal.aborted) {
      await patchTask(userId, taskId, { status: "cancelled" });
      await appendEvent(userId, taskId, { type: "status", data: { status: "cancelled" } });
      return;
    }

    await patchTask(userId, taskId, { status: "publishing" });
    await appendEvent(userId, taskId, {
      type: "status",
      data: { status: "publishing", message: "Collecting changes and creating a draft PR." },
    });

    // Stop the code runner before reading/publishing its working tree.
    await dockerWorkspaceRuntime.stop(workspaceId);
    const changes = await scanWorkspace(repoPath, baseEntries);
    if (!changes.length) {
      await patchTask(userId, taskId, { status: "completed_no_changes" });
      await appendEvent(userId, taskId, {
        type: "status",
        data: { status: "completed_no_changes", message: "No repository changes were produced; no PR was opened." },
      });
      return;
    }

    const pr = await publishDraftPullRequest({
      octokit: octokit,
      owner: task.owner,
      repo: task.repo,
      task: { prompt: task.prompt, branch: task.branch, baseBranch: task.base_branch },
      baseTreeSha: baseTreeSha,
      baseSha: task.base_sha,
      changes: changes,
      summary: pipelineResult.implementationSummary + "\n\nQuality review: " + pipelineResult.review,
    });
    await patchTask(userId, taskId, { status: "review_ready", pr_url: pr.url, pr_number: pr.number });
    await appendEvent(userId, taskId, { type: "pull_request", data: { ...pr, draft: true } });
    await appendEvent(userId, taskId, {
      type: "status",
      data: { status: "review_ready", message: "Draft PR opened. Human review is required before merge." },
    });
  } catch (error) {
    if (/Quality gate/.test(error.message)) error.retryable = false;
    logger.error("Repository agent task failed", { taskId: taskId, userId: userId, error: error.message });
    await patchTask(userId, taskId, {
      status: abortSignal.aborted ? "cancelled" : "failed",
      error: error.message,
    });
    await appendEvent(userId, taskId, { type: "error", data: { message: error.message } });
    if (error.retryable === false) return { status: "failed", retryable: false }; 
    throw error;
  } finally {
    try { await dockerWorkspaceRuntime.stop(workspaceId); } catch {}
    activeTasks.delete(taskId);
  }
}

/**
 * Validate repository access and queue a task. Actual code execution begins
 * asynchronously after the durable task row has been committed.
 */
export async function startRepoAgentTask(options) {
  const userId = options.userId;
  const token = options.token;
  const owner = options.owner;
  const repo = options.repo;
  const prompt = options.prompt;
  const baseBranch = options.baseBranch;

  if (config.executionRuntime !== "docker") {
    const error = new Error("Repository agents require EXECUTION_RUNTIME=docker on a worker with Docker Engine access. Unsandboxed fallback is disabled.");
    error.statusCode = 503;
    throw error;
  }
  if (!token) {
    const error = new Error("Connect GitHub before starting a repository agent.");
    error.statusCode = 400;
    throw error;
  }
  if (!/^[A-Za-z0-9-]{1,39}$/.test(owner) ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(repo) ||
      repo === "." || repo === "..") {
    const error = new Error("Invalid repository owner or name.");
    error.statusCode = 400;
    throw error;
  }
  if (typeof prompt !== "string" || !prompt.trim() || prompt.trim().length > 10000) {
    const error = new Error("Prompt is required and must be at most 10,000 characters.");
    error.statusCode = 400;
    throw error;
  }

  const runningCount = getDatabase().prepare(
    "SELECT COUNT(*) AS count FROM repo_agent_tasks WHERE user_id = ? AND status IN ('queued','cloning','running','publishing')"
  ).get(userId).count;
  if (runningCount >= MAX_ACTIVE_TASKS_PER_USER) {
    const error = new Error("A maximum of " + MAX_ACTIVE_TASKS_PER_USER + " repository agent tasks may run at once per user.");
    error.statusCode = 429;
    throw error;
  }

  const octokit = getOctokit(token);
  const repositoryResponse = await octokit.repos.get({ owner: owner, repo: repo });
  const repository = repositoryResponse.data;
  if (!repository.permissions || repository.permissions.push !== true) {
    const error = new Error("The connected GitHub account needs push permission on this repository to create a PR branch.");
    error.statusCode = 403;
    throw error;
  }

  const selectedBase = baseBranch || repository.default_branch;
  if (typeof selectedBase !== "string" || !/^[A-Za-z0-9._/-]{1,200}$/.test(selectedBase) ||
      selectedBase.startsWith("-") || selectedBase.endsWith("/") ||
      selectedBase.includes("..") || selectedBase.includes("//") || selectedBase.includes("@{")) {
    const error = new Error("Invalid base branch name.");
    error.statusCode = 400;
    throw error;
  }

  const refResponse = await octokit.git.getRef({
    owner: owner, repo: repo, ref: "heads/" + selectedBase,
  });
  const baseSha = refResponse.data.object.sha;
  const commitResponse = await octokit.git.getCommit({
    owner: owner, repo: repo, commit_sha: baseSha,
  });
  const baseTreeSha = commitResponse.data.tree.sha;
  const treeResponse = await octokit.git.getTree({
    owner: owner, repo: repo, tree_sha: baseTreeSha, recursive: "true",
  });
  if (treeResponse.data.truncated || treeResponse.data.tree.length > MAX_TREE_ENTRIES) {
    const error = new Error("Repository tree is too large for this task (limit 25,000 entries).");
    error.statusCode = 413;
    throw error;
  }

  const baseEntries = new Map();
  const protectedPaths = [];
  for (const item of treeResponse.data.tree || []) {
    if (item.type === "blob" && sensitive(item.path)) {
      protectedPaths.push(item.path);
    } else if (item.type === "blob" && !ignored(item.path)) {
      baseEntries.set(item.path, {
        sha: item.sha,
        mode: item.mode,
        size: item.size || 0,
      });
    }
  }

  const taskId = crypto.randomUUID();
  const branchName = "ath-ide/" + taskId.slice(0, 8);
  const userWorkspace = getWorkspaceService(userId);
  const taskDir = path.join(userWorkspace.workspaceRoot, ".agent-runs", taskId);
  const repoPath = path.join(taskDir, "repo");

  getDatabase().prepare(
    "INSERT INTO repo_agent_tasks (id,user_id,owner,repo,base_branch,base_sha,branch,prompt,workspace_path,status,events_json) VALUES (?,?,?,?,?,?,?,?,?,'queued','[]')"
  ).run(taskId, userId, owner, repo, selectedBase, baseSha, branchName, prompt.trim(), repoPath);

  const task = {
    id: taskId,
    user_id: userId,
    owner: owner,
    repo: repo,
    base_branch: selectedBase,
    base_sha: baseSha,
    branch: branchName,
    prompt: prompt.trim(),
    workspace_path: repoPath,
  };
  activeTasks.set(taskId, {
    userId: userId,
    abort: new AbortController(),
    workspaceId: "repo-agent-" + taskId,
  });
  setImmediate(function () {
    executeTask(task, token, octokit, baseTreeSha, baseEntries, protectedPaths).catch(function (error) {
      logger.error("Uncaught repository agent failure", { taskId: taskId, error: error.message });
      patchTask(userId, taskId, { status: "failed", error: error.message });
    });
  });

  return publicTask(rowForUser(userId, taskId));
}

/**
 * Mark tasks interrupted by an API worker restart instead of displaying them
 * as permanently running when their in-memory sandbox no longer exists.
 */
export function recoverRepoAgentTasks() {
  const result = getDatabase().prepare(
    "UPDATE repo_agent_tasks SET status = 'interrupted', error = 'Server restarted before this task completed.', updated_at = datetime('now') WHERE status IN ('queued','cloning','running','publishing')"
  ).run();
  return result.changes;
}

export function getRepoAgentTask(userId, taskId) {
  return publicTask(rowForUser(userId, taskId));
}

export function listRepoAgentTasks(userId) {
  return getDatabase().prepare(
    "SELECT * FROM repo_agent_tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT 25"
  ).all(userId).map(publicTask);
}

export async function cancelRepoAgentTask(userId, taskId) {
  const row = rowForUser(userId, taskId);
  if (!row) return null;
  const active = activeTasks.get(taskId);
  if (active && active.userId === userId) {
    active.abort.abort();
    await dockerWorkspaceRuntime.stop(active.workspaceId);
  }
  patchTask(userId, taskId, { status: "cancelled" });
  appendEvent(userId, taskId, { type: "status", data: { status: "cancelled" } });
  return getRepoAgentTask(userId, taskId);
}
