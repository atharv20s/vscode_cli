/**
 * GitHub routes — authenticated repository discovery and PR agent tasks.
 */
import { Router } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { requireAuth } from "../middleware/auth.js";
import { githubLimiter } from "../middleware/rateLimiter.js";
import { findUserById } from "../db/database.js";
import { createWorkspaceSession } from "../services/workspaceSessionService.js";
import { getWorkspaceService } from "../services/workspaceService.js";
import { sanitizeSecrets } from "../services/secretSanitizer.js";
import {
  createTaskShare, listTaskShares, revokeTaskShare,
  getSharedTask, addSharedTaskComment, submitSharedTaskInstruction,
} from "../controllers/repoAgentShareController.js";
import {
  listRepos,
  getRepoTree,
  createRepositoryAgentTask,
  getRepositoryAgentTask,
  getRepositoryAgentTasks,
  getRepositoryAgentWorkerPool,
  cancelRepositoryAgentTask,
} from "../controllers/githubController.js";

const router = Router();

router.use(githubLimiter);

// Capability URLs are intentionally public; possession of the unguessable,
// expiring token grants only the role selected by the task owner.
router.get("/shares", getSharedTask);
router.post("/shares/comments", addSharedTaskComment);
router.post("/shares/instructions", submitSharedTaskInstruction);

router.use(requireAuth);

router.get("/repos", listRepos);
router.get("/repos/:owner/:repo/tree", getRepoTree);
router.get("/agent-tasks", getRepositoryAgentTasks);
router.get("/worker-pool", getRepositoryAgentWorkerPool);
router.post("/agent-tasks/:taskId/shares", createTaskShare);
router.get("/agent-tasks/:taskId/shares", listTaskShares);
router.delete("/shares/:shareId", revokeTaskShare);
router.post("/repos/:owner/:repo/clone", async (req, res) => {
  const owner = String(req.params.owner || "").trim();
  const repo = String(req.params.repo || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) {
    return res.status(400).json({ error: "InvalidRepositoryName", message: "Invalid repository owner or name." });
  }
  try {
    const user = await findUserById(req.user.id);
    const token = user?.github_access_token;
    if (!token) {
      return res.status(401).json({ error: "GitHubNotConnected", message: "Connect GitHub first to clone private or writable repositories." });
    }
    const session = await createWorkspaceSession(req.user.id, `${owner}/${repo}`);
    const workspace = getWorkspaceService(req.user.id, session.id);
    await fs.mkdir(workspace.workspaceRoot, { recursive: true });
    const basicAuth = Buffer.from(`x-access-token:${token}`).toString("base64");
    const execFileAsync = promisify(execFile);
    const repoUrl = `https://github.com/${owner}/${repo}.git`;
    await execFileAsync(
      "git",
      ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basicAuth}`, "clone", "--depth=1", repoUrl, "."],
      { cwd: workspace.workspaceRoot, timeout: 60000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }
    );
    await execFileAsync("git", ["config", "user.name", user.username || owner], { cwd: workspace.workspaceRoot, windowsHide: true }).catch(() => {});
    await execFileAsync("git", ["config", "user.email", user.email || `${owner}@users.noreply.github.com`], { cwd: workspace.workspaceRoot, windowsHide: true }).catch(() => {});
    return res.status(201).json({ success: true, session, repo: `${owner}/${repo}` });
  } catch (err) {
    return res.status(500).json({ error: "GitCloneFailed", message: sanitizeSecrets(err.message || "Failed to clone repository.") });
  }
});

router.post("/repos/:owner/:repo/agent-tasks", createRepositoryAgentTask);
router.get("/agent-tasks/:taskId", getRepositoryAgentTask);
router.delete("/agent-tasks/:taskId", cancelRepositoryAgentTask);

export default router;
