/**
 * MCP Server — Exposes the agent's tools as an MCP-compliant server.
 *
 * External MCP clients (Claude Desktop, Cursor, etc.) can connect
 * to this server and use the agent's tools.
 *
 * Implements JSON-RPC 2.0 over stdio.
 * Supports: initialize, tools/list, tools/call, resources/list, resources/read
 */

import { getToolDefinitions, executeTool } from "../tools/index.js";
import { config } from "../config/env.js";
import fs from "fs/promises";
import path from "path";

const SERVER_INFO = {
  name: "agentic-cli-server",
  version: "1.0.0",
};

const CAPABILITIES = {
  tools: {},
  resources: {},
};

/**
 * Handle a JSON-RPC request and return a response.
 */
async function handleRequest(method, params, id) {
  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: CAPABILITIES,
          serverInfo: SERVER_INFO,
        },
      };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: getToolDefinitions().map((t) => ({
            name: t.function.name,
            description: t.function.description,
            inputSchema: t.function.parameters,
          })),
        },
      };

    case "tools/call": {
      const { name, arguments: args } = params;
      const result = await executeTool(name, args || {}, {
        workspaceDir: config.workspaceRoot,
      });

      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: result.success ? result.output : `Error: ${result.error}`,
            },
          ],
          isError: !result.success,
        },
      };
    }

    case "resources/list": {
      // Expose workspace files as resources
      try {
        const entries = await fs.readdir(config.workspaceRoot, {
          withFileTypes: true,
          recursive: false,
        });

        const resources = entries
          .filter((e) => !e.name.startsWith("."))
          .map((e) => ({
            uri: `file://workspace/${e.name}`,
            name: e.name,
            mimeType: e.isDirectory() ? "inode/directory" : "text/plain",
          }));

        return {
          jsonrpc: "2.0",
          id,
          result: { resources },
        };
      } catch {
        return {
          jsonrpc: "2.0",
          id,
          result: { resources: [] },
        };
      }
    }

    case "resources/read": {
      const { uri } = params;
      const filePath = uri.replace("file://workspace/", "");
      const resolved = path.resolve(config.workspaceRoot, filePath);

      if (!resolved.startsWith(path.resolve(config.workspaceRoot))) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32600, message: "Access denied" },
        };
      }

      try {
        const content = await fs.readFile(resolved, "utf8");
        return {
          jsonrpc: "2.0",
          id,
          result: {
            contents: [
              {
                uri,
                mimeType: "text/plain",
                text: content,
              },
            ],
          },
        };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: err.message },
        };
      }
    }

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

/**
 * Start the MCP server on stdio.
 * This function is meant to be run as a standalone process:
 *   node src/mcp/mcpServer.js
 */
export async function startMcpStdioServer() {
  let buffer = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (data) => {
    buffer += data;

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed);

        // Handle notifications (no id)
        if (msg.id === undefined) {
          // Notifications like "notifications/initialized" — just acknowledge
          return;
        }

        const response = await handleRequest(msg.method, msg.params, msg.id);
        process.stdout.write(JSON.stringify(response) + "\n");
      } catch (err) {
        const errorResponse = {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: `Parse error: ${err.message}` },
        };
        process.stdout.write(JSON.stringify(errorResponse) + "\n");
      }
    }
  });

  process.stderr.write(`MCP Server '${SERVER_INFO.name}' v${SERVER_INFO.version} started on stdio\n`);
}

// If run directly as a script
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isMain) {
  // Initialize tools first
  const { initializeTools } = await import("../tools/index.js");
  initializeTools();
  startMcpStdioServer();
}
