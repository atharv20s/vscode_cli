/**
 * GitHub routes — authenticated repository discovery and PR agent tasks.
 */
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { githubLimiter } from "../middleware/rateLimiter.js";
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
router.post("/repos/:owner/:repo/agent-tasks", createRepositoryAgentTask);
router.get("/agent-tasks/:taskId", getRepositoryAgentTask);
router.delete("/agent-tasks/:taskId", cancelRepositoryAgentTask);

export default router;
