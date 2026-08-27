/**
 * Tool Registry — Central management for all agent tools.
 *
 * Mirrors the Python ToolRegistry pattern but in pure JavaScript.
 * Tools are registered with OpenAI function-calling schemas and
 * dispatched by name during the agentic loop.
 */

/** @type {Map<string, { schema: object, handler: Function }>} */
const tools = new Map();

/**
 * Register a tool.
 * @param {object} schema - OpenAI function calling schema
 * @param {Function} handler - async (args, context) => result
 */
export function registerTool(schema, handler) {
  const name = schema.function.name;
  tools.set(name, { schema, handler });
}

/**
 * Get all tool definitions in OpenAI format.
 * @returns {object[]}
 */
export function getToolDefinitions() {
  return Array.from(tools.values()).map((t) => t.schema);
}

/**
 * Get the list of registered tool names.
 * @returns {string[]}
 */
export function listTools() {
  return Array.from(tools.keys());
}

/**
 * Execute a tool by name.
 * @param {string} name - Tool name
 * @param {object} args - Arguments from the LLM
 * @param {object} context - Execution context (workspaceDir, etc.)
 * @returns {Promise<{ success: boolean, output?: string, error?: string }>}
 */
export async function executeTool(name, args, context = {}) {
  const tool = tools.get(name);
  if (!tool) {
    return { success: false, error: `Unknown tool: ${name}` };
  }

  try {
    const result = await tool.handler(args, context);
    return result;
  } catch (err) {
    return { success: false, error: `Tool execution failed: ${err.message}` };
  }
}

/**
 * Check if a tool is registered.
 * @param {string} name
 * @returns {boolean}
 */
export function hasTool(name) {
  return tools.has(name);
}

/**
 * Clear all registered tools (useful for testing).
 */
export function clearTools() {
  tools.clear();
}

// ============================================
// Import and register all built-in tools
// ============================================

import { registerFileTools } from "./fileTools.js";
import { registerSearchTools } from "./searchTools.js";
import { registerShellTools } from "./shellTools.js";
import { registerGitTools } from "./gitTools.js";
import { registerPreviewTools } from "./previewTools.js";

/**
 * Initialize all built-in tools.
 * Call this once at startup.
 */
export function initializeTools() {
  registerFileTools();
  registerSearchTools();
  registerShellTools();
  registerGitTools();
  registerPreviewTools();
}
