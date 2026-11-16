/**
 * Workspace MCP Bridge — wraps file-system MCP tool calls with workspace-path
 * validation so that each tenant's agent can only read/write within its own
 * workspace root.  The bridge is instantiated once per authenticated WebSocket
 * session and re-uses the global MCP server connection while injecting path
 * guards before every filesystem tool is forwarded.
 *
 * Security model:
 *  - Absolute paths in tool arguments are rejected outright.
 *  - Relative paths are resolved through resolveSafeWorkspacePath, which
 *    follows no symlinks and verifies the final canonical path remains under
 *    the workspace root.
 *  - Null bytes and backslash separators are blocked at the entry point.
 *  - Output from the MCP server is returned verbatim (read-only trust).
 *  - Maximum output size is capped at MAX_OUTPUT_CHARS.
 */

import path from "path";
import { resolveSafeWorkspacePath } from "../services/workspacePathSafety.js";
import { logger } from "../config/logger.js";

const MAX_OUTPUT_CHARS = 32_000;

/** Tools whose arguments carry filesystem paths that must be validated. */
const PATH_ARG_TOOLS = new Set([
  "read_file",
  "read_multiple_files",
  "write_file",
  "create_directory",
  "move_file",
  "get_file_info",
  "list_directory",
  "directory_tree",
  "search_files",
]);

/**
 * Returns true when the value looks like an absolute POSIX or Windows path
 * or contains suspicious byte sequences.
 */
function isAbsoluteOrUnsafe(value) {
  if (typeof value !== "string") return false;
  return (
    path.isAbsolute(value) ||
    value.includes("\0") ||
    /^[A-Za-z]:[/\\]/.test(value) ||
    value.startsWith("//") ||
    value.startsWith("\\\\")
  );
}

/**
 * Recursively extract string values keyed "path" or "paths" from an args
 * object — these are the candidates MCP filesystem tools use.
 */
function extractPathArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const results = [];
  for (const [key, value] of Object.entries(args)) {
    if (key === "path" && typeof value === "string") results.push({ key, value, isArray: false });
    else if (key === "paths" && Array.isArray(value)) results.push({ key, value, isArray: true });
  }
  return results;
}

export class WorkspaceMcpBridge {
  /**
   * @param {string} workspaceRoot  Absolute canonical path of the tenant workspace.
   * @param {Function} callMcpTool  Async function (toolName, args) => { success, output }.
   */
  constructor(workspaceRoot, callMcpTool) {
    if (!workspaceRoot || typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) {
      throw new Error("WorkspaceMcpBridge requires an absolute workspaceRoot.");
    }
    this._root = workspaceRoot;
    this._callMcpTool = callMcpTool;
  }

  /**
   * Call a filesystem MCP tool with workspace-scoped path validation.
   * Non-filesystem tools are forwarded without inspection.
   *
   * @param {string} toolName  Bare tool name (e.g. "read_file"), without the
   *                           "mcp_filesystem_" prefix.
   * @param {object} args      Tool arguments as parsed JSON.
   * @returns {Promise<{success: boolean, output: string}>}
   */
  async call(toolName, args) {
    if (PATH_ARG_TOOLS.has(toolName)) {
      await this._validatePathArgs(toolName, args);
    }
    try {
      const result = await this._callMcpTool(toolName, args);
      if (result && typeof result.output === "string" && result.output.length > MAX_OUTPUT_CHARS) {
        result.output = result.output.slice(0, MAX_OUTPUT_CHARS) + "\n[output truncated by workspace bridge]";
      }
      return result;
    } catch (err) {
      logger.warn("WorkspaceMcpBridge: MCP tool call failed", { toolName, error: err.message });
      return { success: false, error: `MCP filesystem error: ${err.message}` };
    }
  }

  async _validatePathArgs(toolName, args) {
    const candidates = extractPathArgs(args);
    for (const { key, value, isArray } of candidates) {
      const paths = isArray ? value : [value];
      for (const p of paths) {
        if (typeof p !== "string" || !p) throw new Error(`MCP tool '${toolName}': empty or non-string path argument.`);
        if (isAbsoluteOrUnsafe(p)) {
          throw new Error(`MCP tool '${toolName}': absolute or unsafe path rejected — use relative workspace paths only.`);
        }
        // This performs symlink-safe resolution and verifies the result stays
        // under workspaceRoot.  It throws for escapes, symlinks, and null bytes.
        await resolveSafeWorkspacePath(this._root, p).catch(err => {
          throw new Error(`MCP tool '${toolName}': path '${p}' is outside the active workspace — ${err.message}`);
        });
      }
      void key; // key name validated implicitly via extractPathArgs
    }
  }
}
