/**
 * Git & GitHub Tools — Version control & cloud repo operations.
 */

import { exec } from "child_process";
import { registerTool } from "./index.js";
import { config } from "../config/env.js";
import { commitFilesToRepo } from "../services/githubService.js";

/**
 * Run a git command and return the result.
 */
function runGit(args, cwd) {
  return new Promise((resolve) => {
    exec(`git ${args}`, { cwd, timeout: 20000 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
      } else {
        resolve({ success: true, output: stdout.trim() || "(no output)" });
      }
    });
  });
}

export function registerGitTools() {
  // ---- git_status ----
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
    async (_args, ctx) => {
      const cwd = ctx.workspaceDir || config.workspaceRoot;
      return runGit("status --short --branch", cwd);
    }
  );

  // ---- git_diff ----
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
    async (args, ctx) => {
      const cwd = ctx.workspaceDir || config.workspaceRoot;
      const flag = args.staged ? "--staged" : "";
      return runGit(`diff ${flag}`, cwd);
    }
  );

  // ---- git_log ----
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
    async (args, ctx) => {
      const cwd = ctx.workspaceDir || config.workspaceRoot;
      const n = args.count || 10;
      return runGit(`log --oneline --graph -n ${n}`, cwd);
    }
  );

  // ---- git_commit ----
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
    async (args, ctx) => {
      const cwd = ctx.workspaceDir || config.workspaceRoot;

      const stageResult = await runGit("add -A", cwd);
      if (!stageResult.success) return stageResult;

      const safeMessage = args.message.replace(/"/g, '\\"');
      return runGit(`commit -m "${safeMessage}"`, cwd);
    }
  );

  // ---- git_push ----
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
    async (args, ctx) => {
      const cwd = ctx.workspaceDir || config.workspaceRoot;
      const remote = args.remote || "origin";
      const branch = args.branch || "main";
      return runGit(`push ${remote} ${branch}`, cwd);
    }
  );

  // ---- github_cloud_commit ----
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
    async (args, ctx) => {
      const token = ctx.user?.githubAccessToken || process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
      if (!token) {
        return {
          success: false,
          error: "GitHub token not found. Connect GitHub in the topbar or set GITHUB_PERSONAL_ACCESS_TOKEN in .env",
        };
      }

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
          output: `✅ Successfully committed to GitHub!\nCommit SHA: ${result.commitSha}\nURL: ${result.url}`,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  );
}
