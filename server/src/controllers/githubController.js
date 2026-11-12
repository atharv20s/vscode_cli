/**
 * GitHub Controller — Server-side GitHub access and repository agent tasks.
 */
import { findUserById } from "../db/database.js";
import { repoAgentQueue } from "../services/repoAgentQueue.js";
import {
  listUserRepos,
  getRepoTree as fetchRepoTree,
} from "../services/githubService.js";
import {
  startRepoAgentTask,
  getRepoAgentTask,
  listRepoAgentTasks,
  cancelRepoAgentTask,
} from "../services/repoAgentService.js";

/**
 * GitHub credentials stay in the server-side user record. Never accept PATs
 * from query strings or browser-supplied headers for authenticated operations.
 */
function getGitHubToken(req) {
  if (!req.user?.id) return "";
  const user = findUserById(req.user.id);
  return user?.github_access_token || "";
}

export async function listRepos(req, res) {
  const token = getGitHubToken(req);
  if (!token) {
    return res.status(400).json({
      error: "GitHubNotConnected",
      message: "Connect GitHub in your account settings before selecting a repository.",
    });
  }
  try {
    const repos = await listUserRepos(token);
    return res.json({ repos });
  } catch (error) {
    return res.status(502).json({ error: "GitHubError", message: error.message });
  }
}

export async function getRepoTree(req, res) {
  const token = getGitHubToken(req);
  if (!token) return res.status(400).json({ error: "GitHubNotConnected" });
  const owner = req.params.owner;
  const repo = req.params.repo;
  const branch = typeof req.query.branch === "string" ? req.query.branch : "main";
  try {
    const tree = await fetchRepoTree(token, owner, repo, branch);
    return res.json({ owner: owner, repo: repo, branch: branch, tree: tree });
  } catch (error) {
    return res.status(502).json({ error: "GitHubError", message: error.message });
  }
}

export async function createRepositoryAgentTask(req, res) {
  const token = getGitHubToken(req);
  if (!token) return res.status(400).json({ error: "GitHubNotConnected" });
  try {
    const task = await startRepoAgentTask({
      userId: req.user.id,
      token: token,
      owner: req.params.owner,
      repo: req.params.repo,
      prompt: req.body?.prompt,
      baseBranch: req.body?.baseBranch,
    });
    return res.status(202).json({ success: true, task: task });
  } catch (error) {
    const status = Number.isInteger(error.statusCode) ? error.statusCode : 502;
    return res.status(status).json({ error: "RepositoryAgentError", message: error.message });
  }
}

export async function getRepositoryAgentTask(req, res) {
  const task = await getRepoAgentTask(req.user.id, req.params.taskId);
  if (!task) return res.status(404).json({ error: "TaskNotFound" });
  return res.json({ task: task });
}

export async function getRepositoryAgentTasks(req, res) {
  return res.json({ tasks: await listRepoAgentTasks(req.user.id) });
}

export async function cancelRepositoryAgentTask(req, res) {
  const task = await cancelRepoAgentTask(req.user.id, req.params.taskId);
  if (!task) return res.status(404).json({ error: "TaskNotFound" });
  return res.json({ success: true, task: task });
}

/** Return aggregate worker health without exposing hostnames or process IDs. */
export async function getRepositoryAgentWorkerPool(req,res) {
  try {
    const workers = await repoAgentQueue.listWorkers();
    return res.json({
      queue: "redis-streams",
      onlineWorkers: workers.length,
      busyWorkers: workers.filter(worker => Boolean(worker.currentTaskId)).length,
      idleWorkers: workers.filter(worker => !worker.currentTaskId).length,
      lastHeartbeat: workers.map(worker=>worker.updatedAt).sort().at(-1) || null,
    });
  } catch(error) {
    return res.status(503).json({error:"WorkerPoolUnavailable",message:"Repository agent queue is unavailable."});
  }
}
