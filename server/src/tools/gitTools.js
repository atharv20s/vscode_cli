/**
 * Git & GitHub Tools — Version Control & Cloud Operations
 * 
 * Routes operations through PermissionEngine for security policy checks
 * and GitService for repository execution.
 */

import { registerTool } from "./index.js";
import { config } from "../config/env.js";
import { gitService } from "../services/gitService.js";
import { permissionEngine } from "../services/permissionEngine.js";
import { commitFilesToRepo } from "../services/githubService.js";

export function registerGitTools() {
  // 1. git_status
  registerTool(
    {
      type: "function",
      function: {
        name: "git_status",
        description: "Get current git status showing modified, staged, and untracked files.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    async (_args, ctx = {}) => {
      const cwd = ctx.workspaceDir || config.workspaceRoot;
      const status = await gitService.getStatus(cwd);
      return {
        success: true,
        output: status.raw || `On branch ${status.branch} (clean)`,
        status,
      };
    }
  );

  // 2. git_diff
  registerTool(
    {
      type: "function",
      function: {
        name: "git_diff",
        description: "Show diff of uncommitted changes in the workspace.",
        parameters: {
          type: "object",
          properties: {
            staged: { type: "boolean", description: "If true, show only staged changes" },
          },
          required: [],
        },
      },
    },
    async (args, ctx = {}) => {
      const cwd = ctx.workspaceDir || config.workspaceRoot;
      const result = await gitService.getDiff(args.staged, cwd);
      return { success: result.success, output: result.diff || "(no changes)" };
    }
  );

  // 3. git_log
  registerTool(
    {
      type: "function",
      function: {
        name: "git_log",
        description: "Show recent git commit history.",
        parameters: {
          type: "object",
          properties: {
            count: { type: "integer", description: "Number of commits to show (default: 10)" },
          },
          required: [],
        },
      },
    },
    async (args, ctx = {}) => {
      const cwd = ctx.workspaceDir || config.workspaceRoot;
      const result = await gitService.getLog(args.count || 10, cwd);
      return { success: result.success, output: result.log };
    }
  );

  // 4. git_commit
  registerTool(
    {
      type: "function",
      function: {
        name: "git_commit",
        description: "Stage all modified workspace files and create a git commit.",
        parameters: {
          type: "object",
          properties: {
            message: { type: "string", description: "Clear, descriptive commit message" },
          },
          required: ["message"],
        },
      },
    },
    async (args, ctx = {}) => {
      // Permission Check
      const perm = await permissionEngine.checkPermission({
        resource: "git",
        action: "commit",
        payload: args,
        turnId: ctx.turnId,
        sessionId: ctx.sessionId,
      });
      if (!perm.granted) return { success: false, error: perm.reason };

      const cwd = ctx.workspaceDir || config.workspaceRoot;
      const result = await gitService.commit(args.message, cwd);
      return { success: result.success, output: result.output };
    }
  );

  // 5. git_push
  registerTool(
    {
      type: "function",
      function: {
        name: "git_push",
        description: "Push committed changes to remote repository (e.g. GitHub origin main).",
        parameters: {
          type: "object",
          properties: {
            remote: { type: "string", description: "Remote name (default: origin)" },
            branch: { type: "string", description: "Branch name (default: main)" },
          },
          required: [],
        },
      },
    },
    async (args, ctx = {}) => {
      // Permission Check (Requires ASK by default)
      const perm = await permissionEngine.checkPermission({
        resource: "git",
        action: "push",
        payload: args,
        turnId: ctx.turnId,
        sessionId: ctx.sessionId,
      });
      if (!perm.granted) return { success: false, error: perm.reason };

      const cwd = ctx.workspaceDir || config.workspaceRoot;
      const result = await gitService.push(args.remote || "origin", args.branch || null, cwd);
      return { success: result.success, output: result.output };
    }
  );

  // 6. github_cloud_commit
  registerTool(
    {
      type: "function",
      function: {
        name: "github_cloud_commit",
        description:
          "Directly commit and push files to a GitHub repository via GitHub REST API. " +
          "Requires user GitHub OAuth token or personal access token.",
        parameters: {
          type: "object",
          properties: {
            owner: { type: "string", description: "GitHub username or organization" },
            repo: { type: "string", description: "Repository name" },
            branch: { type: "string", description: "Branch name (default: main)" },
            commit_message: { type: "string", description: "Commit message" },
            files: {
              type: "array",
              description: "Array of files to commit [{path: string, content: string}]",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  content: { type: "string" },
                },
                required: ["path", "content"],
              },
            },
          },
          required: ["owner", "repo", "files", "commit_message"],
        },
      },
    },
    async (args, ctx = {}) => {
      const token = ctx.user?.githubAccessToken || process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
      if (!token) {
        return {
          success: false,
          error: "GitHub token not found. Connect GitHub in the topbar or set GITHUB_PERSONAL_ACCESS_TOKEN in .env",
        };
      }

      // Permission Check
      const perm = await permissionEngine.checkPermission({
        resource: "github",
        action: "push",
        payload: { owner: args.owner, repo: args.repo, branch: args.branch },
        turnId: ctx.turnId,
        sessionId: ctx.sessionId,
      });
      if (!perm.granted) return { success: false, error: perm.reason };

      try {
        const result = await commitFilesToRepo(token, {
          owner: args.owner,
          repo: args.repo,
          branch: args.branch || "main",
          files: args.files,
          commitMessage: args.commit_message,
        });

        return {
          success: true,
          output: `Successfully committed to GitHub!\nCommit SHA: ${result.commitSha}\nURL: ${result.url}`,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  );

  // 7. github_list_repos
  registerTool(
    {
      type: "function",
      function: {
        name: "github_list_repos",
        description: "List repositories for the authenticated user or organization.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    async (_args, ctx = {}) => {
      const token = ctx.user?.githubAccessToken || process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
      if (!token) {
        return {
          success: false,
          error: "GitHub token not found. Set GITHUB_PERSONAL_ACCESS_TOKEN in .env",
        };
      }
      try {
        const { listUserRepos } = await import("../services/githubService.js");
        const repos = await listUserRepos(token);
        const formatted = repos.slice(0, 15).map(r => `- ${r.fullName} (${r.language || "Unknown"}) - ${r.isPrivate ? "Private" : "Public"}\n  ${r.htmlUrl}`).join("\n");
        return { success: true, count: repos.length, output: formatted, repos };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  );

  // 8. github_create_pr
  registerTool(
    {
      type: "function",
      function: {
        name: "github_create_pr",
        description: "Create a GitHub Pull Request.",
        parameters: {
          type: "object",
          properties: {
            owner: { type: "string", description: "Repository owner" },
            repo: { type: "string", description: "Repository name" },
            title: { type: "string", description: "Pull request title" },
            body: { type: "string", description: "Pull request description / body" },
            head: { type: "string", description: "Branch containing changes (e.g. feature-branch)" },
            base: { type: "string", description: "Target branch to merge into (default: main)" },
          },
          required: ["owner", "repo", "title", "head"],
        },
      },
    },
    async (args, ctx = {}) => {
      const token = ctx.user?.githubAccessToken || process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
      if (!token) {
        return {
          success: false,
          error: "GitHub token not found. Set GITHUB_PERSONAL_ACCESS_TOKEN in .env",
        };
      }

      const perm = await permissionEngine.checkPermission({
        resource: "github",
        action: "create_pr",
        payload: args,
        turnId: ctx.turnId,
        sessionId: ctx.sessionId,
      });
      if (!perm.granted) return { success: false, error: perm.reason };

      try {
        const { getOctokit } = await import("../services/githubService.js");
        const octokit = getOctokit(token);
        const { data } = await octokit.pulls.create({
          owner: args.owner,
          repo: args.repo,
          title: args.title,
          body: args.body || "",
          head: args.head,
          base: args.base || "main",
        });
        return {
          success: true,
          output: `Pull Request created successfully: #${data.number} - ${data.title}\nURL: ${data.html_url}`,
          prNumber: data.number,
          url: data.html_url,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  );
}

