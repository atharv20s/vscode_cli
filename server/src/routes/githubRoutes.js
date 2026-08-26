/**
 * GitHub Routes — Proxy to GitHub API for repos, commits, PRs.
 */

import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { githubLimiter } from "../middleware/rateLimiter.js";
import {
  listRepos,
  getRepoTree,
  commitFiles,
} from "../controllers/githubController.js";

const router = Router();

router.get("/repos", requireAuth, githubLimiter, listRepos);
router.get("/repos/:owner/:repo/tree", requireAuth, githubLimiter, getRepoTree);
router.post("/repos/:owner/:repo/commit", requireAuth, githubLimiter, commitFiles);

export default router;
