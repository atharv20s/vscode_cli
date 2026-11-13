/**
 * Preview Tools — Development Server & Live Application Preview
 * 
 * Provides agent tools to start, stop, and inspect live preview web servers
 * with automated localhost port detection and readiness synchronization.
 */

import { registerTool } from "./index.js";
import { getPreviewService } from "../services/previewService.js";
import { getWorkspaceServiceForContext } from "../services/workspaceService.js";
import { generatePreviewToken } from "../middleware/auth.js";
import { config } from "../config/env.js";
import { permissionEngine } from "../services/permissionEngine.js";

function inferPreviewPort(command, explicitPort) {
  if (Number.isInteger(Number(explicitPort)) && Number(explicitPort) >= 1024 && Number(explicitPort) <= 65535) {
    return Number(explicitPort);
  }
  const text = String(command || "").toLowerCase();
  const explicit = text.match(/(?:--port(?:=|\s+)|\s-p\s+|port=)(\d{2,5})/);
  if (explicit) return Number(explicit[1]);
  if (/\b(vite|astro)\b/.test(text)) return /\bastro\b/.test(text) ? 4321 : 5173;
  if (/\b(uvicorn|fastapi|http\.server)\b/.test(text)) return 8000;
  if (/\b(flask)\b/.test(text)) return 5000;
  return 3000;
}

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
      const workspace = getWorkspaceServiceForContext(ctx);
      const baseDir = workspace.workspaceRoot;
      const target = workspace.resolvePath(args.working_dir || ".");
      if (!target.safe) return { success: false, error: "Preview directory is outside your workspace." };
      const cwd = target.resolved;

      try {
        const command = args.command || "npm run dev";
        if (String(ctx.workspaceId || "").startsWith("repo-agent-")) {
          return { success: false, error: "Preview servers are disabled in disposable repository-agent sandboxes." };
        }
        const perm = await permissionEngine.checkPermission({
          resource: "command",
          action: "execute",
          payload: { command, working_dir: args.working_dir || "." },
          turnId: ctx.turnId,
          sessionId: ctx.sessionId,
          workspaceId: ctx.workspaceId,
        });
        if (!perm.granted) return { success: false, error: perm.reason || "Starting a preview requires approval." };
        const port = inferPreviewPort(command, args.port);
        const result = await previewService.startPreview({
          command,
          cwd,
          port,
          workspaceDir: baseDir,
          previewToken: ctx.userId && ctx.workspaceKey ? generatePreviewToken(ctx.userId, ctx.workspaceKey, port) : null,
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
      if (state.status === "running" && ctx.userId && ctx.workspaceKey && config.previewPublicUrl) {
        const token = generatePreviewToken(ctx.userId, ctx.workspaceKey);
        state.url = config.previewPublicUrl.replace(/\/$/, "") + "/preview/" + generatePreviewToken(ctx.userId, ctx.workspaceKey, state.port) + "/";
      }
      return {
        success: true,
        output: JSON.stringify(state, null, 2),
        state,
      };
    }
  );
}
