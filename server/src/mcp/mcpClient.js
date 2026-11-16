/**
 * MCP Client — Connects to configured external MCP servers and registers tools.
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
const MAX_MCP_TOOLS = 100;
const MAX_TOOL_OUTPUT_CHARS = 32_000;
const connectedServers = new Map();

export function filterMcpTools(tools, allowedTools) {
  if (!Array.isArray(tools)) return [];
  const allow = Array.isArray(allowedTools) ? new Set(allowedTools) : null;
  return tools.filter(tool =>
    tool &&
    typeof tool.name === "string" &&
    /^[A-Za-z0-9_.-]{1,48}$/.test(tool.name) &&
    (!allow || allow.has(tool.name)) &&
    tool.inputSchema && typeof tool.inputSchema === "object" &&
    !Array.isArray(tool.inputSchema) &&
    tool.inputSchema.type === "object" &&
    JSON.stringify(tool.inputSchema).length <= 16_384
  ).slice(0, MAX_MCP_TOOLS);
}

export async function initMcpServers() {
  let configData;
  try {
    configData = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
  } catch {
    logger.info("No mcp_config.json found or invalid — MCP servers disabled.", { path: CONFIG_PATH });
    return;
  }
  for (const [name, serverConfig] of Object.entries(configData.mcpServers || {})) {
    try { await connectServer(name, serverConfig); }
    catch (err) { logger.error(`Failed to connect MCP server '${name}'`, { error: err.message }); }
  }
  logger.info(`MCP client initialized: ${connectedServers.size} server(s) connected`);
}

async function connectServer(name, serverConfig) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new Error("Invalid MCP server name.");
  if (!serverConfig || typeof serverConfig !== "object" || serverConfig.enabled === false) return;
  const { command, args = [], env = {}, transport = "stdio", allowedTools } = serverConfig;
  if (transport !== "stdio") {
    logger.warn(`MCP server '${name}' uses unsupported transport '${transport}' — skipping`);
    return;
  }
  if (typeof command !== "string" || !command.trim() || command.length > 256) throw new Error("MCP command must be a non-empty executable name.");
  if (!Array.isArray(args) || args.length > 100 || args.some(arg => typeof arg !== "string" || arg.length > 2048)) throw new Error("MCP args must be an array of bounded strings.");
  if (allowedTools !== undefined && (!Array.isArray(allowedTools) || allowedTools.some(tool => typeof tool !== "string"))) throw new Error("MCP allowedTools must be an array of tool names.");

  const resolvedArgs = args.map(arg => {
    if (arg === "./workspace" || arg === "workspace") {
      try { if (!fsSync.existsSync(config.workspaceRoot)) fsSync.mkdirSync(config.workspaceRoot, { recursive: true }); } catch {}
      return config.workspaceRoot;
    }
    if (arg.startsWith("src/")) return path.resolve(__dirname, "..", arg.slice(4));
    return arg;
  });

  logger.info(`Connecting MCP server '${name}' using executable '${command}'`);
  const tp = new StdioTransport(command, resolvedArgs, env);
  tp.on("error", err => logger.error(`MCP server '${name}' error: ${err.message}`));
  tp.on("close", code => {
    logger.warn(`MCP server '${name}' exited with code ${code}`);
    connectedServers.delete(name);
  });
  await tp.connect();

  try {
    const initResult = await tp.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "agentic-cli", version: "1.0.0" },
    });
    logger.debug(`MCP '${name}' initialized`, { serverInfo: initResult?.serverInfo });
    tp.notify("notifications/initialized");
  } catch (err) {
    logger.error(`MCP '${name}' initialization failed: ${err.message}`);
    await tp.disconnect();
    return;
  }

  let discovered = [];
  try {
    const result = await tp.request("tools/list", {});
    discovered = filterMcpTools(result?.tools, allowedTools);
    logger.info(`MCP '${name}': registered ${discovered.length} of ${result?.tools?.length || 0} discovered tool(s)`, {
      tools: discovered.map(tool => tool.name),
    });
  } catch (err) {
    logger.warn(`MCP '${name}': tools/list failed: ${err.message}`);
  }
  connectedServers.set(name, { transport: tp, tools: discovered });

  for (const tool of discovered) {
    const mcpToolName = `mcp_${name}_${tool.name}`;
    if (mcpToolName.length > 64) {
      logger.warn(`Skipping overlong MCP tool name from '${name}': ${tool.name}`);
      continue;
    }
    registerTool({
      type: "function",
      function: {
        name: mcpToolName,
        description: `[MCP:${name}] ${String(tool.description || tool.name).slice(0, 1024)}`,
        parameters: tool.inputSchema,
      },
    }, async args => {
      try {
        const result = await tp.request("tools/call", { name: tool.name, arguments: args });
        const textParts = (Array.isArray(result?.content) ? result.content : [])
          .filter(item => item?.type === "text" && typeof item.text === "string")
          .map(item => item.text);
        const output = textParts.join("\n");
        return {
          success: !result?.isError,
          output: output.length > MAX_TOOL_OUTPUT_CHARS ? output.slice(0, MAX_TOOL_OUTPUT_CHARS) + "\n[output truncated]" : output || "Tool executed successfully.",
        };
      } catch (err) {
        return { success: false, error: `MCP tool error: ${err.message}` };
      }
    });
    logger.debug(`Registered MCP tool: ${mcpToolName}`);
  }
}

export async function shutdownMcpServers() {
  for (const [name, { transport }] of connectedServers) {
    logger.info(`Disconnecting MCP server '${name}'`);
    await transport.disconnect();
  }
  connectedServers.clear();
}

export function getMcpStatus() {
  const status = {};
  for (const [name, { transport, tools }] of connectedServers) {
    status[name] = { connected: transport.isConnected, toolCount: tools.length, tools: tools.map(tool => tool.name) };
  }
  return status;
}
