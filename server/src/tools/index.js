/**
 * Tool Registry — Central management for all agent tools.
 *
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

const TOOL_ALIASES = {
  // Shell execution aliases
  execute_command: "run_command",
  exec_command: "run_command",
  shell: "run_command",
  terminal: "run_command",
  bash: "run_command",
  // File tool aliases
  readFile: "read_file",
  writeFile: "write_file",
  editFile: "edit_file",
  deleteFile: "delete_file",
  listFiles: "list_files",
  list_dir: "list_files",
  listDirectory: "list_files",
  // Compile aliases
  compile: "compile_file",
  compileCode: "compile_file",
  compile_code: "compile_file",
  // Launch/preview aliases
  launch: "launch_file",
  preview: "launch_file",
  launch_preview: "launch_file",
  startPreview: "start_preview",
  // Git aliases
  gitStatus: "git_status",
  gitDiff: "git_diff",
  gitLog: "git_log",
  gitCommit: "git_commit",
  gitPush: "git_push",
  gitPull: "git_pull",
  gitBranch: "git_branch",
  gitClone: "git_clone",
  // GitHub aliases
  createRepo: "github_create_repo",
  githubCreateRepo: "github_create_repo",
  createIssue: "github_create_issue",
  githubCreateIssue: "github_create_issue",
  createPR: "github_create_pr",
  createPullRequest: "github_create_pr",
  githubCreatePR: "github_create_pr",
  getRepoInfo: "github_get_repo_info",
  repoInfo: "github_get_repo_info",
  listRepos: "github_list_repos",
  cloudCommit: "github_cloud_commit",
  // Doc/diagram aliases
  generateDiagram: "generate_uml_diagram",
  generate_diagram: "generate_uml_diagram",
  uml_diagram: "generate_uml_diagram",
  architecture_diagram: "generate_uml_diagram",
  generateReadme: "generate_readme",
  create_readme: "generate_readme",
  makeReadme: "generate_readme",
  generateWalkthrough: "generate_walkthrough",
};

/**
 * Execute a tool by name.
 * @param {string} name - Tool name
 * @param {object} args - Arguments from the LLM
 * @param {object} context - Execution context (workspaceDir, etc.)
 * @returns {Promise<{ success: boolean, output?: string, error?: string }>}
 */
export async function executeTool(name, args, context = {}) {
  const resolvedName = TOOL_ALIASES[name] || name;
  const tool = tools.get(resolvedName) || tools.get(name);
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
import { registerImageTools } from "./imageTools.js";
import { registerPlanningTools } from "./planningTools.js";
import { registerDiagnosticTools } from "./diagnosticTools.js";
import { registerDocTools } from "./docTools.js";

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
  registerImageTools();
  registerPlanningTools();
  registerDiagnosticTools();
  registerDocTools();
}
