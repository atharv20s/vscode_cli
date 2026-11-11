/**
 * Preview Tools — Development Server & Live Application Preview
 * 
 * Provides agent tools to start, stop, and inspect live preview web servers
 * with automated localhost port detection and readiness synchronization.
 */

import { registerTool } from "./index.js";
import { getPreviewService } from "../services/previewService.js";
import { getWorkspaceService } from "../services/workspaceService.js";

export function registerPreviewTools() {
  // 1. start_preview
  registerTool(
    {
      type: "function",
      function: {
        name: "start_preview",
        description:
          "Start a development server or preview process for the web application (e.g. 'npm run dev', 'vite', 'npm start', 'python -m http.server 8000') and automatically display live preview in the IDE preview panel.",
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The command to start the dev server (default: 'npm run dev')",
            },
            working_dir: {
              type: "string",
              description: "Optional working directory relative to workspace root",
            },
            port: {
              type: "integer",
              description: "Optional port override if already known (e.g. 5173, 3000)",
            },
          },
          required: [],
        },
      },
    },
    async (args, ctx = {}) => {
      const previewService = getPreviewService(ctx.workspaceId);
      const workspace = getWorkspaceService(ctx.userId);
      const baseDir = workspace.workspaceRoot;
      const target = workspace.resolvePath(args.working_dir || ".");
      if (!target.safe) return { success: false, error: "Preview directory is outside your workspace." };
      const cwd = target.resolved;

      try {
        const result = await previewService.startPreview({
          command: args.command || "npm run dev",
          cwd,
          port: args.port || null,
        });

        if (result.success) {
          return {
            success: true,
            output: `Live preview ready and streaming at ${result.url} (Port: ${result.port})`,
            url: result.url,
            port: result.port,
          };
        } else {
          return {
            success: false,
            error: result.error || "Failed to start preview server.",
          };
        }
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  );

  // 2. stop_preview
  registerTool(
    {
      type: "function",
      function: {
        name: "stop_preview",
        description: "Stop the active live preview development server.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    async (args, ctx = {}) => {
      const previewService = getPreviewService(ctx.workspaceId);
      try {
        await previewService.stopPreview();
        return { success: true, output: "Preview server stopped successfully." };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  );

  // 3. get_preview_status
  registerTool(
    {
      type: "function",
      function: {
        name: "get_preview_status",
        description: "Get the current live preview URL, port, and health status.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    async (args, ctx = {}) => {
      const previewService = getPreviewService(ctx.workspaceId);
      const state = previewService.getPreviewState();
      return {
        success: true,
        output: JSON.stringify(state, null, 2),
        state,
      };
    }
  );
}
