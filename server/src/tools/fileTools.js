/**
 * File Tools — Read, write, edit, and list files in the workspace.
 *
 * All paths are sandboxed to the workspace directory.
 * Path traversal attacks are blocked.
 */

import fs from "fs/promises";
import path from "path";
import { registerTool } from "./index.js";
import { config } from "../config/env.js";

/**
 * Resolve a path safely within the workspace.
 * @param {string} filePath - Relative or absolute file path
 * @param {string} [workspaceDir] - Override workspace root
 * @returns {{ safe: boolean, resolved: string }}
 */
function safePath(filePath, workspaceDir) {
  const root = workspaceDir || config.workspaceRoot;
  const resolved = path.resolve(root, filePath);

  // Block path traversal
  if (!resolved.startsWith(path.resolve(root))) {
    return { safe: false, resolved };
  }

  return { safe: true, resolved };
}

export function registerFileTools() {
  // ---- read_file ----
  registerTool(
    {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read the contents of a file. Supports optional line range for large files.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path to the file" },
            start_line: {
              type: "integer",
              description: "Optional start line (1-based)",
            },
            end_line: {
              type: "integer",
              description: "Optional end line (1-based, inclusive)",
            },
          },
          required: ["path"],
        },
      },
    },
    async (args, ctx) => {
      const { safe, resolved } = safePath(args.path, ctx.workspaceDir);
      if (!safe) return { success: false, error: "Access denied: path outside workspace" };

      try {
        const content = await fs.readFile(resolved, "utf8");

        if (args.start_line || args.end_line) {
          const lines = content.split("\n");
          const start = Math.max(1, args.start_line || 1) - 1;
          const end = Math.min(lines.length, args.end_line || lines.length);
          const slice = lines.slice(start, end);
          return {
            success: true,
            output: slice
              .map((line, i) => `${start + i + 1}: ${line}`)
              .join("\n"),
          };
        }

        return { success: true, output: content };
      } catch (err) {
        if (err.code === "ENOENT") {
          return { success: false, error: `File not found: ${args.path}` };
        }
        return { success: false, error: err.message };
      }
    }
  );

  // ---- write_file ----
  registerTool(
    {
      type: "function",
      function: {
        name: "write_file",
        description:
          "Create or overwrite a file in the workspace. Creates parent directories automatically.",
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
    async (args, ctx) => {
      const { safe, resolved } = safePath(args.path, ctx.workspaceDir);
      if (!safe) return { success: false, error: "Access denied: path outside workspace" };

      try {
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, args.content, "utf8");
        return {
          success: true,
          output: `✅ Successfully written to ${args.path} (${args.content.length} bytes)`,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  );

  // ---- edit_file ----
  registerTool(
    {
      type: "function",
      function: {
        name: "edit_file",
        description:
          "Edit a file by searching for a string and replacing it. Shows a diff of changes.",
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
    async (args, ctx) => {
      const { safe, resolved } = safePath(args.path, ctx.workspaceDir);
      if (!safe) return { success: false, error: "Access denied: path outside workspace" };

      try {
        const original = await fs.readFile(resolved, "utf8");

        if (!original.includes(args.search)) {
          return {
            success: false,
            error: `Search string not found in ${args.path}`,
          };
        }

        const updated = original.replace(args.search, args.replace);
        await fs.writeFile(resolved, updated, "utf8");

        return {
          success: true,
          output: `✅ Edited ${args.path}\n\n--- Before ---\n${args.search}\n\n+++ After +++\n${args.replace}`,
        };
      } catch (err) {
        if (err.code === "ENOENT") {
          return { success: false, error: `File not found: ${args.path}` };
        }
        return { success: false, error: err.message };
      }
    }
  );

  // ---- list_dir ----
  registerTool(
    {
      type: "function",
      function: {
        name: "list_dir",
        description:
          "List files and subdirectories in a directory with metadata.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative path to the directory (default: '.')",
            },
          },
          required: [],
        },
      },
    },
    async (args, ctx) => {
      const dirPath = args.path || ".";
      const { safe, resolved } = safePath(dirPath, ctx.workspaceDir);
      if (!safe) return { success: false, error: "Access denied: path outside workspace" };

      try {
        const entries = await fs.readdir(resolved, { withFileTypes: true });
        const items = await Promise.all(
          entries
            .filter((e) => !e.name.startsWith("."))
            .map(async (entry) => {
              const entryPath = path.join(resolved, entry.name);
              if (entry.isDirectory()) {
                return `📁 ${entry.name}/`;
              }
              try {
                const stat = await fs.stat(entryPath);
                const sizeKb = (stat.size / 1024).toFixed(1);
                return `📄 ${entry.name} (${sizeKb} KB)`;
              } catch {
                return `📄 ${entry.name}`;
              }
            })
        );

        return {
          success: true,
          output: items.length > 0
            ? `Contents of ${dirPath}/:\n${items.join("\n")}`
            : `Empty directory: ${dirPath}/`,
        };
      } catch (err) {
        if (err.code === "ENOENT") {
          return { success: false, error: `Directory not found: ${dirPath}` };
        }
        return { success: false, error: err.message };
      }
    }
  );
}
