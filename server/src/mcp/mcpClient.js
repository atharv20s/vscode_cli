/**
 * MCP Client — Connects to external MCP servers and integrates their tools.
 *
 * Flow:
 * 1. Read mcp_config.json for server definitions
 * 2. Spawn each server process via StdioTransport
 * 3. Send `initialize` → `tools/list` to discover available tools
 * 4. Register discovered tools in the agent's tool registry
 * 5. Proxy `tools/call` from agent loop to the MCP server
 */

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { StdioTransport } from "./mcpTransport.js";
import { registerTool } from "../tools/index.js";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, "../../mcp_config.json");

/** @type {Map<string, { transport: StdioTransport, tools: object[] }>} */
const connectedServers = new Map();

/**
 * Initialize all MCP servers from config.
 */
export async function initMcpServers() {
  let configData;

  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    configData = JSON.parse(raw);
  } catch (err) {
    logger.info("No mcp_config.json found or invalid — MCP servers disabled.", {
      path: CONFIG_PATH,
    });
    return;
  }

  const servers = configData.mcpServers || {};

  for (const [name, serverConfig] of Object.entries(servers)) {
    try {
      await connectServer(name, serverConfig);
    } catch (err) {
      logger.error(`Failed to connect MCP server '${name}'`, {
        error: err.message,
      });
    }
  }

  logger.info(`MCP client initialized: ${connectedServers.size} server(s) connected`);
}

/**
 * Connect to a single MCP server.
 */
async function connectServer(name, serverConfig) {
  const { command, args = [], env = {}, transport = "stdio" } = serverConfig;

  if (transport !== "stdio") {
    logger.warn(`MCP server '${name}' uses unsupported transport '${transport}' — skipping`);
    return;
  }

  const resolvedArgs = args.map((arg) => {
    if (arg === "./workspace" || arg === "workspace") {
      try {
        if (!fsSync.existsSync(config.workspaceRoot)) {
          fsSync.mkdirSync(config.workspaceRoot, { recursive: true });
        }
      } catch {}
      return config.workspaceRoot;
    }
    if (arg.startsWith("src/")) {
      return path.resolve(__dirname, "..", arg.slice(4));
    }
    return arg;
  });

  logger.info(`Connecting to MCP server '${name}': ${command} ${resolvedArgs.join(" ")}`);

  const tp = new StdioTransport(command, resolvedArgs, env);

  tp.on("error", (err) => {
    logger.error(`MCP server '${name}' error: ${err.message}`);
  });

  tp.on("close", (code) => {
    logger.warn(`MCP server '${name}' exited with code ${code}`);
    connectedServers.delete(name);
  });

  await tp.connect();

  // Initialize the MCP session
  try {
    const initResult = await tp.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
      },
      clientInfo: {
        name: "agentic-cli",
        version: "1.0.0",
      },
    });

    logger.debug(`MCP '${name}' initialized`, { serverInfo: initResult?.serverInfo });

    // Send initialized notification
    tp.notify("notifications/initialized");
  } catch (err) {
    logger.error(`MCP '${name}' initialization failed: ${err.message}`);
    await tp.disconnect();
    return;
  }

  // Discover tools
  let tools = [];
  try {
    const result = await tp.request("tools/list", {});
    tools = result?.tools || [];
    logger.info(`MCP '${name}': discovered ${tools.length} tool(s)`, {
      tools: tools.map((t) => t.name),
    });
  } catch (err) {
    logger.warn(`MCP '${name}': tools/list failed: ${err.message}`);
  }

  connectedServers.set(name, { transport: tp, tools });

  // Register discovered tools in the agent's tool registry
  for (const tool of tools) {
    const mcpToolName = `mcp_${name}_${tool.name}`;

    registerTool(
      {
        type: "function",
        function: {
          name: mcpToolName,
          description: `[MCP:${name}] ${tool.description || tool.name}`,
          parameters: tool.inputSchema || { type: "object", properties: {} },
        },
      },
      async (args) => {
        try {
          const result = await tp.request("tools/call", {
            name: tool.name,
            arguments: args,
          });

          // MCP tools return content array
          const content = result?.content || [];
          const textParts = content
            .filter((c) => c.type === "text")
            .map((c) => c.text);

          return {
            success: !result?.isError,
            output: textParts.join("\n") || "Tool executed successfully.",
          };
        } catch (err) {
          return { success: false, error: `MCP tool error: ${err.message}` };
        }
      }
    );

    logger.debug(`Registered MCP tool: ${mcpToolName}`);
  }
}

/**
 * Disconnect all MCP servers.
 */
export async function shutdownMcpServers() {
  for (const [name, { transport }] of connectedServers) {
    logger.info(`Disconnecting MCP server '${name}'`);
    await transport.disconnect();
  }
  connectedServers.clear();
}

/**
 * Get status of all connected MCP servers.
 */
export function getMcpStatus() {
  const status = {};
  for (const [name, { transport, tools }] of connectedServers) {
    status[name] = {
      connected: transport.isConnected,
      toolCount: tools.length,
      tools: tools.map((t) => t.name),
    };
  }
  return status;
}
