/**
 * Context Selector — Targeted LLM Prompt Context Slicing
 * 
 * Analyzes user intent and queries WorldState to inject only the relevant
 * environmental context slices into the LLM prompt, keeping token usage fast and focused.
 */

import { worldStateService } from "./worldStateService.js";

export class ContextSelector {
  /**
   * Select targeted environmental context based on user prompt and active state.
   * 
   * @param {object} params
   * @param {string} params.userPrompt
   * @param {string} [params.sessionId]
   * @param {object} [params.editorContext]
   * @returns {string} Formatted context block for the system prompt
   */
  static selectContext({ userPrompt = "", sessionId = null, editorContext = null }) {
    const world = worldStateService.getWorldState(sessionId);
    const pLower = userPrompt.toLowerCase();
    const parts = [];

    // 1. Base Workspace Header (Always present)
    parts.push(`- Workspace: ${world.workspace.name} (${world.workspace.root})`);

    // Intent Flags
    const isTerminalIntent = /terminal|error|fail|command|run|npm|test|build|powershell|bash|cmd|node/i.test(pLower);
    const isPreviewIntent = /preview|port|localhost|server|site|web|app|browser|ui/i.test(pLower);
    const isGitIntent = /git|commit|push|pull|branch|diff|status|repo|github/i.test(pLower);
    const isCodeIntent = /file|edit|code|function|component|create|write|read|refactor|fix/i.test(pLower);

    // 2. Terminal & Process Context (Included on terminal intent or when errors exist)
    const hasRecentErrors = world.terminal.recent_errors && world.terminal.recent_errors.length > 0;
    if (isTerminalIntent || hasRecentErrors || !userPrompt) {
      if (world.terminal.shell) {
        parts.push(`- Terminal Shell: ${world.terminal.shell} [${world.terminal.state}] in ${world.terminal.cwd}`);
      }
      if (world.terminal.active_process) {
        parts.push(`- Active Foreground Process: ${world.terminal.active_process}`);
      }
      if (world.terminal.last_command) {
        parts.push(`- Last Command in Terminal: "${world.terminal.last_command}" (${world.terminal.last_command_time})`);
        if (world.terminal.exit_code !== null) parts.push(`- Last Command Exit Code: ${world.terminal.exit_code}`);
      }
      if (hasRecentErrors) {
        parts.push(`- Recent Terminal Errors:\n\`\`\`\n${world.terminal.recent_errors.slice(-4).join("\n")}\n\`\`\``);
      } else if (world.terminal.recent_output && world.terminal.recent_output.length > 0) {
        parts.push(`- Recent Terminal Output Tail:\n\`\`\`\n${world.terminal.recent_output.slice(-6).join("\n")}\n\`\`\``);
      }
    }

    // 3. Live Preview & Network Context (Included on preview intent or when preview is active)
    if (isPreviewIntent || world.preview.status === "running") {
      if (world.preview.status === "running") {
        parts.push(`- Live Preview Server: RUNNING at ${world.preview.url} (Port: ${world.preview.port})`);
      } else if (world.terminal.detected_ports && world.terminal.detected_ports.length > 0) {
        parts.push(`- Detected Active Ports: ${world.terminal.detected_ports.join(", ")}`);
      }
    }

    // 4. Git Version Control Context (Included on git intent or dirty repository)
    if (isGitIntent || (world.git && world.git.dirty)) {
      if (world.git.branch) {
        parts.push(`- Git Branch: ${world.git.branch} (${world.git.dirty ? `${world.git.totalChanges} uncommitted changes` : "clean"})`);
      }
    }

    // 5. Active Editor Context (Included on code intent or when file is open)
    if (editorContext) {
      if (editorContext.activeFile) {
        parts.push(`- Active Open File in Editor: ${editorContext.activeFile}`);
      }
      if (editorContext.openFiles && editorContext.openFiles.length > 0) {
        parts.push(`- Open Editor Tabs: ${editorContext.openFiles.join(", ")}`);
      }
      if (editorContext.activeContent && (isCodeIntent || !userPrompt)) {
        parts.push(`- Active File Code Preview (${editorContext.activeFile}):\n\`\`\`\n${editorContext.activeContent.slice(0, 1500)}\n\`\`\``);
      }
    }

    if (parts.length === 0) return "";

    return `\n\n[LIVE IDE ENVIRONMENT CONTEXT]:\n${parts.join("\n")}\nUse this real-time context to accurately assist the user without redundant discovery steps.`;
  }
}
