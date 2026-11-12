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
import {
  countActiveRepoTasks, createRepoTask, getRepoTask, listRepoTasks,
  updateRepoTask, appendRepoTaskEvent, getRepoTaskGithubToken,
} from "../db/repoAgentStore.js";
import { repoAgentQueue } from "./repoAgentQueue.js";
import { runRepoAgentPipeline } from "./repoAgentPipeline.js";
import { config } from "../config/env.js";
import { getPostgresPool } from "../db/postgres.js";
import { logger } from "../config/logger.js";
import { createScopedWorkspaceService } from "./workspaceService.js";
import { dockerWorkspaceRuntime } from "./dockerWorkspaceRuntime.js";
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
  await options.assertLease?.();
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

  await options.assertLease?.();
  const createdTree = await octokit.git.createTree({
    owner: owner,
    repo: repo,
    base_tree: options.baseTreeSha,
    tree: tree,
  });
  await options.assertLease?.();
  const commit = await octokit.git.createCommit({
    owner: owner,
    repo: repo,
    message: "ATH IDE: " + task.prompt.slice(0, 65).replace(/\s+/g, " "),
    tree: createdTree.data.sha,
    parents: [options.baseSha],
  });
  await options.assertLease?.();
  await octokit.git.createRef({
    owner: owner,
    repo: repo,
    ref: "refs/heads/" + task.branch,
    sha: commit.data.sha,
  });

  await options.assertLease?.();
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

  await options.assertLease?.();
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

async function executeTask(task, token, octokit, baseTreeSha, baseEntries, protectedPaths, signal = null, assertLease = null) {
  const userId = task.user_id;
  const taskId = task.id;
  const repoPath = task.workspace_path;
  const taskDir = path.dirname(repoPath);
  const workspaceId = "repo-agent-" + taskId;
  const abortSignal = signal || new AbortController().signal;
  let leaseLost = false;

  try {
    await patchTask(userId, taskId, { status: "cloning" });
    await appendEvent(userId, taskId, {
      type: "status",
      data: { status: "cloning", message: "Cloning " + task.owner + "/" + task.repo },
    });
    await fs.rm(taskDir, { recursive: true, force: true });
    await fs.mkdir(taskDir, { recursive: true, mode: 0o700 });
    await cloneRepository(token, task.owner, task.repo, task.base_branch, repoPath, taskDir);
    await assertLease?.();

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

    await assertLease?.();
    const workspaceService = createScopedWorkspaceService(repoPath, workspaceId);
    // No local fallback: task code only runs when Docker isolation is available.
    await dockerWorkspaceRuntime.ensureContainer(workspaceId, repoPath, { network: config.repoAgentNetwork, replaceExisting: true, restartPolicy: "no" });
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

    await assertLease?.();
    await patchTask(userId, taskId, { status: "publishing" });
    await appendEvent(userId, taskId, {
      type: "status",
      data: { status: "publishing", message: "Collecting changes and creating a draft PR." },
    });

    // Stop the code runner before reading/publishing its working tree.
    await dockerWorkspaceRuntime.stop(workspaceId);
    await assertLease?.();
    const changes = await scanWorkspace(repoPath, baseEntries);
    if (!changes.length) {
      await patchTask(userId, taskId, { status: "completed_no_changes" });
      await appendEvent(userId, taskId, {
        type: "status",
        data: { status: "completed_no_changes", message: "No repository changes were produced; no PR was opened." },
      });
      await fs.rm(taskDir, { recursive: true, force: true });
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
    await fs.rm(taskDir, { recursive: true, force: true });
  } catch (error) {
    if (error.leaseLost) { leaseLost = true; throw error; }
    if (/Quality gate/.test(error.message)) error.retryable = false;
    try {
      await dockerWorkspaceRuntime.stop(workspaceId);
      await fs.rm(taskDir, { recursive: true, force: true });
    } catch {}
    logger.error("Repository agent task failed", { taskId: taskId, userId: userId, error: error.message });
    await patchTask(userId, taskId, {
      status: abortSignal.aborted ? "cancelled" : "failed",
      error: error.message,
    });
    await appendEvent(userId, taskId, { type: "error", data: { message: error.message } });
    if (error.retryable === false) return { status: "failed", retryable: false }; 
    throw error;
  } finally {
    if (!leaseLost) {
      try { await dockerWorkspaceRuntime.stop(workspaceId); } catch {}
    }
    if (abortSignal.aborted) {
      try { await fs.rm(taskDir, { recursive: true, force: true }); } catch {}
    }
  }
}

/**
 * Validate repository access and queue a task. Actual code execution begins
 * asynchronously after the durable task row has been committed.
 */
/**
 * Called by dedicated Redis consumers. The API process only enqueues task IDs;
 * this worker reloads the GitHub credential from the shared database.
 */
export async function processRepoAgentTask(taskId, options = {}) {
  if (config.executionRuntime !== "docker") {
    throw new Error("Repository task consumers must run on a Docker-enabled worker host.");
  }
  const row = await getRepoTask(taskId);
  if (!row) throw new Error("Repository task does not exist.");
  const token = await getRepoTaskGithubToken(row.user_id);
  if (!token) throw new Error("GitHub connection is missing or expired for the task owner.");

  const octokit = getOctokit(token);
  const commitResponse = await octokit.git.getCommit({
    owner: row.owner, repo: row.repo, commit_sha: row.base_sha,
  });
  const baseTreeSha = commitResponse.data.tree.sha;
  const treeResponse = await octokit.git.getTree({
    owner: row.owner, repo: row.repo, tree_sha: baseTreeSha, recursive: "true",
  });
  if (treeResponse.data.truncated || (treeResponse.data.tree || []).length > MAX_TREE_ENTRIES) {
    const error = new Error("Repository tree exceeds the 25,000-entry task limit.");
    error.retryable = false;
    throw error;
  }

  const baseEntries = new Map();
  const protectedPaths = [];
  for (const item of treeResponse.data.tree || []) {
    if (item.type !== "blob") continue;
    if (sensitive(item.path)) protectedPaths.push(item.path);
    else if (!ignored(item.path)) {
      baseEntries.set(item.path, { sha: item.sha, mode: item.mode, size: item.size || 0 });
    }
  }

  const taskDir = path.join(config.workspaceRoot, ".agent-runs", taskId);
  const repoPath = path.join(taskDir, "repo");
  await fs.mkdir(taskDir, { recursive: true, mode: 0o700 });
  await updateRepoTask(taskId, {
    workspace_path: repoPath,
    worker_id: options.workerId || "repo-agent-worker",
    attempt_count: row.attempt_count || 0,
    status: "cloning",
  });
  const task = {
    id: row.id,
    user_id: row.user_id,
    owner: row.owner,
    repo: row.repo,
    base_branch: row.base_branch,
    base_sha: row.base_sha,
    branch: row.branch,
    prompt: row.prompt,
    workspace_path: repoPath,
    attempt_count: row.attempt_count || 0,
  };
  const assertLease = options.assertLease || (async () => {
    const owned = await repoAgentQueue.ownsLease(taskId, options.leaseToken);
    if (!owned) {
      const error = new Error("Worker lease was lost; this consumer must not publish task changes.");
      error.leaseLost = true;
      throw error;
    }
  });
  return executeTask(task, token, octokit, baseTreeSha, baseEntries, protectedPaths, options.signal || null, assertLease);
}

/**
 * Validate GitHub permissions, persist the task, and enqueue only its ID.
 * The task continues on an independent consumer after the HTTP request returns.
 */
export async function startRepoAgentTask(options) {
  const userId = options.userId;
  const token = options.token;
  const owner = options.owner;
  const repo = options.repo;
  const prompt = options.prompt;
  const baseBranch = options.baseBranch;

  if (!config.redisUrl && !process.env.REDIS_URL) {
    const error = new Error("Redis task queue is not configured. Set REDIS_URL to enable asynchronous repository agents.");
    error.statusCode = 503;
    throw error;
  }
  if (!config.isDev && !getPostgresPool()) {
    const error = new Error("Cloud repository agents require the shared Postgres task store. Configure DATABASE_URL; local SQLite fallback is only supported for single-worker development.");
    error.statusCode = 503;
    throw error;
  }
  if (!token) {
    const error = new Error("Connect GitHub before starting a repository agent.");
    error.statusCode = 400;
    throw error;
  }
  if (!/^[A-Za-z0-9-]{1,39}$/.test(owner) ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === "." || repo === "..") {
    const error = new Error("Invalid repository owner or name.");
    error.statusCode = 400;
    throw error;
  }
  if (typeof prompt !== "string" || !prompt.trim() || prompt.trim().length > 10000) {
    const error = new Error("Prompt is required and must be at most 10,000 characters.");
    error.statusCode = 400;
    throw error;
  }

  const activeCount = await countActiveRepoTasks(userId);
  if (activeCount >= MAX_ACTIVE_TASKS_PER_USER) {
    const error = new Error("A maximum of " + MAX_ACTIVE_TASKS_PER_USER + " repository agent tasks may run at once per user.");
    error.statusCode = 429;
    throw error;
  }

  const octokit = getOctokit(token);
  const repositoryResponse = await octokit.repos.get({ owner, repo });
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
    owner, repo, ref: "heads/" + selectedBase,
  });
  const baseSha = refResponse.data.object.sha;

  const taskId = crypto.randomUUID();
  const branchName = "ath-ide/" + taskId.slice(0, 8);
  await createRepoTask({
    id: taskId,
    userId,
    owner,
    repo,
    baseBranch: selectedBase,
    baseSha,
    branch: branchName,
    prompt: prompt.trim(),
    workspacePath: "",
  });

  try {
    await repoAgentQueue.enqueue(taskId, 0);
    await appendRepoTaskEvent(taskId, {
      type: "queued",
      data: { message: "Task persisted and queued for an independent cloud worker." },
    });
  } catch (error) {
    await updateRepoTask(taskId, { status: "failed", error: "Unable to enqueue task: " + error.message });
    throw Object.assign(new Error("The task was saved but could not be queued. Verify Redis connectivity and retry."), { statusCode: 503 });
  }

  return publicTask(await getRepoTask(taskId, userId));
}

export async function getRepoAgentTask(userId, taskId) {
  const row = await rowForUser(userId, taskId);
  if (!row) return null;
  const task = publicTask(row);
  task.rounds = await listRepoContextRounds(taskId);
  return task;
}

export async function listRepoAgentTasks(userId) {
  const rows = await listRepoTasks(userId, 25);
  return rows.map(publicTask);
}

export async function cancelRepoAgentTask(userId, taskId) {
  const row = await rowForUser(userId, taskId);
  if (!row) return null;
  await updateRepoTask(taskId, { cancel_requested: true, status: "cancel_requested" });
  try { await repoAgentQueue.requestCancellation(taskId); } catch {}
  await appendRepoTaskEvent(taskId, {
    type: "status",
    data: { status: "cancel_requested", message: "Cancellation requested; the active worker will stop at its next safe checkpoint." },
  });
  return getRepoAgentTask(userId, taskId);
}

export async function createRepoAgentShare(userId, taskId, permission = "view", expiresInHours = 168) {
  if (!["view","comment","edit"].includes(permission)) {
    const error = new Error("Share permission must be view, comment or edit.");
    error.statusCode = 400;
    throw error;
  }
  const task = await rowForUser(userId, taskId);
  if (!task) return null;
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const requestedExpiry = Number(expiresInHours);
  if (!Number.isFinite(requestedExpiry) || requestedExpiry < 0) {
    const error = new Error("Share expiry must be zero (no expiry) or a positive number of hours.");
    error.statusCode = 400;
    throw error;
  }
  const expiresAt = requestedExpiry === 0
    ? null
    : new Date(Date.now() + Math.min(Math.max(requestedExpiry,1),720) * 3600000).toISOString();
  const saved = await createRepoShare({
    id: crypto.randomUUID(),
    taskId,
    ownerUserId: userId,
    tokenHash: crypto.createHash("sha256").update(rawToken).digest("hex"),
    permission,
    expiresAt,
  });
  if (!saved) return null;
  return {
    id: saved.id,
    permission,
    expiresAt,
    token: rawToken,
  };
}

export async function getSharedRepoAgentTask(rawToken) {
  if (typeof rawToken !== "string" || rawToken.length < 32 || rawToken.length > 128) return null;
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const share = await getRepoShareByHash(tokenHash);
  if (!share) return null;
  let events = [];
  try { events = Array.isArray(share.events_json) ? share.events_json : JSON.parse(share.events_json || "[]"); } catch {}
  const publicEventTypes = new Set([
    "status","queued","worker_claimed","context_built","agent_round",
    "verification_start","verification_result","pull_request","retry_scheduled",
  ]);
  const safeEvents = events.filter(event => publicEventTypes.has(event.type)).slice(-80).map(event => {
    const data = event.data || {};
    if (event.type === "verification_result") {
      return { at:event.at,type:event.type,data:{
        check:data.name,command:data.command,success:data.success,
        blocked:data.blocked,exitCode:data.exitCode,
      }};
    }
    if (event.type === "agent_round") {
      return { at:event.at,type:event.type,data:{
        role:data.role,round:data.round,status:data.status,
      }};
    }
    if (event.type === "context_built") {
      return { at:event.at,type:event.type,data:{
        fileCount:data.fileCount,retrievedFiles:data.retrievedFiles,
        instructions:data.instructions,
      }};
    }
    if (event.type === "pull_request") {
      return { at:event.at,type:event.type,data:{url:data.url,number:data.number,draft:true} };
    }
    return { at:event.at,type:event.type,data:{
      status:data.status,message:typeof data.message === "string" ? data.message.slice(0,500) : undefined,
      attempt:data.attempt,maxAttempts:data.maxAttempts,workerId:data.workerId,
    }};
  });
  return {
    share: { id: share.id, permission: share.permission, expiresAt: share.expires_at },
    task: {
      id: share.task_id,
      owner: share.owner,
      repo: share.repo,
      baseBranch: share.base_branch,
      branch: share.branch,
      prompt: share.prompt,
      status: share.status,
      events: safeEvents,
      pullRequest: share.pr_url ? { url: share.pr_url, number: share.pr_number } : null,
      error: share.status === "failed" ? "The agent task failed. Ask the owner to inspect the private task log." : null,
      createdAt: share.task_created_at,
    },
    comments: await listRepoShareComments(share.id),
  };
}

export async function commentOnSharedRepoTask(rawToken, body, authorLabel = "Collaborator") {
  if (typeof rawToken !== "string" || rawToken.length < 32) return null;
  if (typeof body !== "string" || !body.trim() || body.length > 4000) {
    const error = new Error("Comment must contain 1 to 4,000 characters.");
    error.statusCode = 400;
    throw error;
  }
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const share = await getRepoShareByHash(tokenHash);
  if (!share || !["comment","edit"].includes(share.permission)) {
    const error = new Error("This share link does not permit comments.");
    error.statusCode = 403;
    throw error;
  }
  const safeAuthor = String(authorLabel || "Collaborator").trim().slice(0,120) || "Collaborator";
  return addRepoShareComment(share.id,safeAuthor,body.trim());
}

export async function submitSharedRepoInstruction(rawToken, instruction, authorLabel = "Collaborator") {
  if (typeof rawToken !== "string" || rawToken.length < 32) return null;
  if (typeof instruction !== "string" || !instruction.trim() || instruction.length > 8000) {
    const error = new Error("Follow-up instruction must contain 1 to 8,000 characters.");
    error.statusCode = 400;
    throw error;
  }
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const share = await getRepoShareByHash(tokenHash);
  if (!share || share.permission !== "edit") {
    const error = new Error("This share link does not permit edit instructions.");
    error.statusCode = 403;
    throw error;
  }
  const token = await getRepoTaskGithubToken(share.owner_user_id);
  const baseBranch = share.pr_url ? share.branch : share.base_branch;
  const task = await startRepoAgentTask({
    userId: share.owner_user_id,
    token,
    owner: share.owner,
    repo: share.repo,
    baseBranch,
    prompt: "Collaborator follow-up for shared task " + share.task_id + " from " + String(authorLabel || "Collaborator").slice(0,120) + ":\n\n" + instruction.trim(),
  });
  await addRepoShareComment(share.id,String(authorLabel || "Collaborator").slice(0,120),"Submitted follow-up agent task " + task.id + ": " + instruction.trim());
  return task;
}

export async function listRepoAgentShares(userId, taskId) {
  const task = await rowForUser(userId,taskId);
  if (!task) return null;
  return listRepoShares(taskId,userId);
}

export async function revokeRepoAgentShare(userId, shareId) {
  return revokeRepoShare(shareId,userId);
}

