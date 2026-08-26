/**
 * GitHub Service — Integration with GitHub API using @octokit/rest.
 *
 * Features:
 * - List repositories for authenticated user
 * - Read repository file tree & contents
 * - Commit changes & push files to GitHub branches
 * - Create pull requests & branches
 */

import { Octokit } from "@octokit/rest";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import { cacheGet, cacheSet, cacheKey } from "./cacheService.js";

/**
 * Create an Octokit instance with user token or fallback token.
 * @param {string} [accessToken] - GitHub personal or OAuth access token
 * @returns {Octokit}
 */
export function getOctokit(accessToken) {
  const token = accessToken || process.env.GITHUB_PERSONAL_ACCESS_TOKEN || "";
  return new Octokit({
    auth: token || undefined,
    userAgent: "agentic-cli-studio/1.0.0",
  });
}

/**
 * List repositories for authenticated user (with 2-minute caching).
 * @param {string} accessToken
 * @returns {Promise<Array>}
 */
export async function listUserRepos(accessToken) {
  const key = cacheKey("github:repos", accessToken || "default");
  const cached = cacheGet(key);
  if (cached) return cached;

  const octokit = getOctokit(accessToken);
  try {
    const { data } = await octokit.repos.listForAuthenticatedUser({
      sort: "updated",
      per_page: 30,
      visibility: "all",
    });

    const repos = data.map((repo) => ({
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      owner: repo.owner.login,
      description: repo.description || "",
      isPrivate: repo.private,
      htmlUrl: repo.html_url,
      cloneUrl: repo.clone_url,
      defaultBranch: repo.default_branch,
      updatedAt: repo.updated_at,
      stars: repo.stargazers_count,
      language: repo.language || "Unknown",
    }));

    cacheSet(key, repos, 120); // Cache for 2 mins
    return repos;
  } catch (err) {
    logger.error("GitHub list repos error", { error: err.message });
    throw new Error(`Failed to list repositories: ${err.message}`);
  }
}

/**
 * Get file tree for a repository.
 * @param {string} accessToken
 * @param {string} owner
 * @param {string} repo
 * @param {string} [branch='main']
 * @returns {Promise<Array>}
 */
export async function getRepoTree(accessToken, owner, repo, branch = "main") {
  const octokit = getOctokit(accessToken);
  try {
    const { data: refData } = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${branch}`,
    });

    const treeSha = refData.object.sha;
    const { data: treeData } = await octokit.git.getTree({
      owner,
      repo,
      tree_sha: treeSha,
      recursive: "true",
    });

    return (treeData.tree || []).map((item) => ({
      path: item.path,
      mode: item.mode,
      type: item.type === "tree" ? "dir" : "file",
      sha: item.sha,
      size: item.size || 0,
    }));
  } catch (err) {
    logger.error("GitHub get tree error", { owner, repo, error: err.message });
    throw new Error(`Failed to fetch repo tree: ${err.message}`);
  }
}

/**
 * Fetch a single file content from GitHub repository.
 * @param {string} accessToken
 * @param {string} owner
 * @param {string} repo
 * @param {string} path
 * @param {string} [ref='main']
 * @returns {Promise<string>}
 */
export async function getRepoFileContent(accessToken, owner, repo, path, ref = "main") {
  const octokit = getOctokit(accessToken);
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });

    if (Array.isArray(data) || !data.content) {
      throw new Error("Target is a directory or empty");
    }

    const content = Buffer.from(data.content, "base64").toString("utf8");
    return content;
  } catch (err) {
    logger.error("GitHub get file content error", { owner, repo, path, error: err.message });
    throw new Error(`Failed to read file from GitHub: ${err.message}`);
  }
}

/**
 * Commit files directly to a GitHub repository branch.
 * @param {string} accessToken
 * @param {object} options
 * @param {string} options.owner
 * @param {string} options.repo
 * @param {string} [options.branch='main']
 * @param {Array<{path: string, content: string}>} options.files
 * @param {string} options.commitMessage
 * @returns {Promise<{ commitSha: string, url: string }>}
 */
export async function commitFilesToRepo(accessToken, { owner, repo, branch = "main", files, commitMessage }) {
  const octokit = getOctokit(accessToken);

  try {
    // 1. Get latest commit on branch
    const { data: refData } = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${branch}`,
    });
    const latestCommitSha = refData.object.sha;

    // 2. Create blobs for each file
    const treeItems = await Promise.all(
      files.map(async (file) => {
        const { data: blobData } = await octokit.git.createBlob({
          owner,
          repo,
          content: Buffer.from(file.content).toString("base64"),
          encoding: "base64",
        });
        return {
          path: file.path,
          mode: "100644",
          type: "blob",
          sha: blobData.sha,
        };
      })
    );

    // 3. Create tree
    const { data: newTree } = await octokit.git.createTree({
      owner,
      repo,
      base_tree: latestCommitSha,
      tree: treeItems,
    });

    // 4. Create commit
    const { data: newCommit } = await octokit.git.createCommit({
      owner,
      repo,
      message: commitMessage || "Updates from Agentic AI Studio",
      tree: newTree.sha,
      parents: [latestCommitSha],
    });

    // 5. Update reference
    await octokit.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: newCommit.sha,
    });

    return {
      commitSha: newCommit.sha,
      url: `https://github.com/${owner}/${repo}/commit/${newCommit.sha}`,
    };
  } catch (err) {
    logger.error("GitHub commit error", { owner, repo, error: err.message });
    throw new Error(`Failed to commit files to GitHub: ${err.message}`);
  }
}
