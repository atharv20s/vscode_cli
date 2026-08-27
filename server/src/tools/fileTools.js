/**
 * File Tools — Centralized Workspace File System Interface
 * 
 * Routes through PermissionEngine for security checks and WorkspaceService
 * for path policy enforcement and lightweight mutation event publishing.
 */

import { registerTool } from "./index.js";
import { workspaceService } from "../services/workspaceService.js";
import { permissionEngine } from "../services/permissionEngine.js";

export function registerFileTools() {
  // 1. read_file
  registerTool(
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read the contents of a file in the workspace. Supports optional line range.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path to the file" },
            start_line: { type: "integer", description: "Optional start line (1-based)" },
            end_line: { type: "integer", description: "Optional end line (1-based, inclusive)" },
          },
          required: ["path"],
        },
      },
    },
    async (args, ctx = {}) => {
      // Permission Check
      const perm = await permissionEngine.checkPermission({
        resource: "file",
        action: "read",
        payload: args,
        turnId: ctx.turnId,
        sessionId: ctx.sessionId,
      });
      if (!perm.granted) return { success: false, error: perm.reason };

      try {
        const result = await workspaceService.readFile(args.path, args.start_line, args.end_line);
        return { success: true, output: result.content };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  );

  // 2. write_file
  registerTool(
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Create or overwrite a file in the workspace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path to the file" },
            content: { type: "string", description: "Content to write" },
          },
          required: ["path", "content"],
        },
      },
    },
    async (args, ctx = {}) => {
      // Permission Check
      const perm = await permissionEngine.checkPermission({
        resource: "file",
        action: "write",
        payload: args,
        turnId: ctx.turnId,
        sessionId: ctx.sessionId,
      });
      if (!perm.granted) return { success: false, error: perm.reason };

      try {
        const result = await workspaceService.writeFile(args.path, args.content, {
          source: "agent",
          actor: "agent",
          turnId: ctx.turnId,
          operationId: ctx.operationId,
        });
        return {
          success: true,
          output: `Successfully written to ${result.path} (${result.size} bytes)`,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  );

  // 3. edit_file
  registerTool(
    {
      type: "function",
      function: {
        name: "edit_file",
        description: "Edit a file by searching for an exact string and replacing it with new content.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path to the file" },
            search: { type: "string", description: "Exact string to find" },
            replace: { type: "string", description: "Replacement string" },
          },
          required: ["path", "search", "replace"],
        },
      },
    },
    async (args, ctx = {}) => {
      // Permission Check
      const perm = await permissionEngine.checkPermission({
        resource: "file",
        action: "edit",
        payload: args,
        turnId: ctx.turnId,
        sessionId: ctx.sessionId,
      });
      if (!perm.granted) return { success: false, error: perm.reason };

      try {
        const file = await workspaceService.readFile(args.path);
        if (!file.content.includes(args.search)) {
          return { success: false, error: `Search string not found in ${args.path}` };
        }

        const updated = file.content.replace(args.search, args.replace);
        await workspaceService.writeFile(args.path, updated, {
          source: "agent",
          actor: "agent",
          turnId: ctx.turnId,
          operationId: ctx.operationId,
        });

        return {
          success: true,
          output: `Edited ${args.path}\n\n--- Before ---\n${args.search}\n\n+++ After +++\n${args.replace}`,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  );

  // 4. list_files / list_dir
  registerTool(
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List files and subdirectories in a workspace directory.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative directory path (default: '.')" },
          },
          required: [],
        },
      },
    },
    async (args, ctx = {}) => {
      const dirPath = args.path || ".";
      try {
        const result = await workspaceService.listDirectory(dirPath);
        const formatted = result.entries.map((e) => (e.isDirectory ? `${e.name}/` : `${e.name} (${(e.size / 1024).toFixed(1)} KB)`));
        return {
          success: true,
          output: formatted.length > 0 ? `Contents of ${dirPath}/:\n${formatted.join("\n")}` : `Empty directory: ${dirPath}/`,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  );
}
