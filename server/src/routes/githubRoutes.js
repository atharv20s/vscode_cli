/**
 * GitHub routes — authenticated repository discovery and PR agent tasks.
 */
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { githubLimiter } from "../middleware/rateLimiter.js";
import {
  listRepos,
  getRepoTree,
  createRepositoryAgentTask,
  getRepositoryAgentTask,
  getRepositoryAgentTasks,
  cancelRepositoryAgentTask,
} from "../controllers/githubController.js";

const router = Router();

router.use(requireAuth);
router.use(githubLimiter);

router.get("/repos", listRepos);
router.get("/repos/:owner/:repo/tree", getRepoTree);
router.get("/agent-tasks", getRepositoryAgentTasks);
router.post("/repos/:owner/:repo/agent-tasks", createRepositoryAgentTask);
router.get("/agent-tasks/:taskId", getRepositoryAgentTask);
router.delete("/agent-tasks/:taskId", cancelRepositoryAgentTask);

export default router;
