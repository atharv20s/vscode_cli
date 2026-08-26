/**
 * GitHub Controller — API endpoints for user repos, commit sync, and PRs.
 */

import {
  listUserRepos,
  getRepoTree as fetchRepoTree,
  commitFilesToRepo,
  getRepoFileContent,
} from "../services/githubService.js";
import fs from "fs/promises";
import path from "path";
import { config } from "../config/env.js";

/**
 * Extract GitHub token from user session or headers.
 */
function getGitHubToken(req) {
  return (
    req.user?.githubAccessToken ||
    req.headers["x-github-token"] ||
    req.query.github_token ||
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN ||
    ""
  );
}

/**
 * GET /api/github/repos — List repositories for authenticated user.
 */
export async function listRepos(req, res) {
  const token = getGitHubToken(req);
  if (!token) {
    return res.status(400).json({
      error: "GitHubNotConnected",
      message: "Connect your GitHub account or paste a GitHub Token to list repositories.",
    });
  }

  try {
    const repos = await listUserRepos(token);
    res.json({ repos });
  } catch (err) {
    res.status(500).json({ error: "GitHubError", message: err.message });
  }
}

/**
 * GET /api/github/repos/:owner/:repo/tree?branch=main
 */
export async function getRepoTree(req, res) {
  const { owner, repo } = req.params;
  const branch = req.query.branch || "main";
  const token = getGitHubToken(req);

  try {
    const tree = await fetchRepoTree(token, owner, repo, branch);
    res.json({ owner, repo, branch, tree });
  } catch (err) {
    res.status(500).json({ error: "GitHubError", message: err.message });
  }
}

/**
 * POST /api/github/repos/:owner/:repo/commit
 * Body: { branch, files: [{ path, content }], commitMessage }
 */
export async function commitFiles(req, res) {
  const { owner, repo } = req.params;
  const { branch = "main", files = [], commitMessage } = req.body;
  const token = getGitHubToken(req);

  if (!token) {
    return res.status(400).json({
      error: "GitHubNotConnected",
      message: "Connect your GitHub account or configure a GitHub access token.",
    });
  }

  if (!files || files.length === 0) {
    return res.status(400).json({ error: "BadRequest", message: "No files provided to commit." });
  }

  try {
    const result = await commitFilesToRepo(token, {
      owner,
      repo,
      branch,
      files,
      commitMessage: commitMessage || "Automated commit via Agentic AI Studio",
    });

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: "GitHubError", message: err.message });
  }
}
