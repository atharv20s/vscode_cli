/**
 * GitHub Routes — Proxy to GitHub API for repos, commits, PRs.
 */

import { Router } from "express";
import { requireAuth, optionalAuth } from "../middleware/auth.js";
import { githubLimiter } from "../middleware/rateLimiter.js";
import {
  listRepos,
  getRepoTree,
  commitFiles,
} from "../controllers/githubController.js";

const router = Router();

router.get("/repos", optionalAuth, githubLimiter, listRepos);
router.get("/repos/:owner/:repo/tree", optionalAuth, githubLimiter, getRepoTree);
router.post("/repos/:owner/:repo/commit", requireAuth, githubLimiter, commitFiles);

export default router;
