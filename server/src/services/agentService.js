/**
 * Agent Service — The Core Autonomous Agent Loop
 *
 * This is the heart of the system. It implements:
 * 1. Send user message + tools to LLM
 * 2. If LLM returns tool_calls → execute → feed results back → loop
 * 3. If LLM returns text → stream it and finish
 * 4. Max iterations guard to prevent infinite loops
 *
 * Mirrors the Python Agent/core.py but in pure JavaScript.
 */

import fs from "fs/promises";
import path from "path";
import { streamChatCompletion } from "./llmService.js";
import { getToolDefinitions, executeTool } from "../tools/index.js";
import { logger } from "../config/logger.js";
import { terminalContextService } from "./terminalContextService.js";
import { worldStateService } from "./worldStateService.js";
import { ContextSelector } from "./contextSelector.js";

/** Default system prompt */
const DEFAULT_SYSTEM_PROMPT = `You are ATH Agent — the core autonomous AI pair programmer embedded inside ATH IDE.

YOU HAVE FULL TOOL-CALLING CAPABILITIES:
- You have access to built-in tools: \`write_file\`, \`edit_file\`, \`read_file\`, \`list_files\`, \`run_command\`, \`web_search\`, \`start_preview\`, etc.
- When the user asks you to create, code, build, or fix a file or application (such as synth.html, snake.html, games, web apps, Python scripts, etc.):
  1. DO NOT say you lack tools. You HAVE \`write_file\`.
  2. Call \`write_file\` to write the complete, functional code directly to the workspace, OR output the entire code in a designated markdown code block (e.g. \`\`\`html synth.html).
  3. Never use placeholders or half-finished code. Always deliver complete, production-ready code.
  4. Embed all CSS in <style> tags and all JS in <script> tags for HTML applications.
  5. Remind the user they can click "Live Preview" or open http://localhost:3001/preview/<filename> to test it immediately.`;

/**
 * Estimate token count for a text string (~4 chars per token).
 */
function estimateTokens(text) {
  if (!text || typeof text !== "string") return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Intelligent Context Compactor:
 * Prunes large intermediate tool outputs and trims older turns if total context approaches limit.
 * Keeps system prompt and recent turns 100% intact.
 */
function compactContext(messages, maxTokenBudget = 85000) {
  let totalEstimated = messages.reduce((acc, m) => {
    let contentLen = typeof m.content === "string" ? m.content.length : JSON.stringify(m.content || "").length;
    return acc + Math.ceil(contentLen / 4);
  }, 0);

  if (totalEstimated <= maxTokenBudget) {
    return messages;
  }

  logger.info(`Context window compaction triggered (${totalEstimated} estimated tokens -> budget: ${maxTokenBudget})`);

  // System prompt is always preserved (index 0)
  const systemMsg = messages[0];
  const otherMsgs = messages.slice(1);

  // Compact older tool results first (anything older than the last 6 messages)
  const cutoffIndex = Math.max(0, otherMsgs.length - 6);

  const compacted = otherMsgs.map((msg, idx) => {
    if (idx < cutoffIndex && msg.role === "tool" && typeof msg.content === "string" && msg.content.length > 500) {
      return {
        ...msg,
        content: msg.content.slice(0, 300) + `\n... [${msg.content.length - 300} characters omitted for context optimization. Full content stored in database & filesystem]`,
      };
    }
    return msg;
  });

  return [systemMsg, ...compacted];
}

/**
 * Run the autonomous agent loop.
 *
 * @param {object} options
 * @param {string} options.message - User's message
 * @param {Array} [options.conversationHistory] - Previous messages
 * @param {string} [options.systemPrompt] - Custom system prompt
 * @param {string} [options.model] - Model to use
 * @param {string} [options.workspaceDir] - Workspace directory for tools
 * @param {number} [options.maxIterations] - Max tool-calling loops (default: 15)
 * @param {AbortSignal} [options.signal] - Abort controller signal
 * @param {Function} options.onEvent - Callback for streaming events
 * @returns {Promise<{ messages: Array, totalTokens: number }>}
 */
/**
 * Write Antigravity-style plan and chat history logs directly to the user's workspace
 * so they appear in the file explorer.
 */
async function writeWorkspaceMetaFiles(message, conversationHistory, workspaceDir) {
  if (!workspaceDir) return;
  try {
    // 1. Create/update chat_session.md
    const historyText = conversationHistory
      .map((msg) => `### **${msg.role === "user" ? "👤 User" : "🤖 Assistant"}**\n${msg.content}\n`)
      .join("\n---\n\n");
    const chatSessionContent = `# 💬 ATH IDE Chat Session\n\n*Updated: ${new Date().toLocaleString()}*\n\n## Current Prompts & Messages\n\n${historyText}\n### **👤 User**\n${message}\n`;
    await fs.writeFile(path.resolve(workspaceDir, "chat_session.md"), chatSessionContent, "utf8");

    // 2. Determine if user prompt is requesting architectural changes/plans
    const lowercaseMsg = message.toLowerCase();
    const needsPlan = ["plan", "design", "implement", "tasks", "architect", "todo", "game", "make", "create", "fix", "error"].some(word => lowercaseMsg.includes(word));
    
    if (needsPlan) {
      // Create implementation_plan.md
      const planContent = `# 📋 Workspace Implementation Plan\n\n*Auto-generated plan for: "${message}"*\n\n## Goal Description\n${message}\n\n## User Review Required\n> [!NOTE]\n> Review the generated plan files in the workspace. Mark tasks as complete in task.md.\n\n## Proposed Changes\n- [NEW] Code modifications based on AI instructions\n- Interactive terminal tests to verify output\n`;
      await fs.writeFile(path.resolve(workspaceDir, "implementation_plan.md"), planContent, "utf8");

      // Create task.md
      const taskContent = `# 🎯 Task Checklist\n\n- [ ] Analyze user prompt: "${message.slice(0, 50)}..."\n- [ ] Run design phase and review dependencies\n- [ ] Write new code blocks and verify implementation\n- [ ] Run terminal-based execution tests\n`;
      await fs.writeFile(path.resolve(workspaceDir, "task.md"), taskContent, "utf8");
      
      // Create walkthrough.md
      const walkthroughContent = `# 🚶 Workspace Walkthrough\n\n*Auto-generated walkthrough summary*\n\n## Changes Made\n- Initialized meta files in workspace explorer\n- Ready for coding actions\n`;
      await fs.writeFile(path.resolve(workspaceDir, "walkthrough.md"), walkthroughContent, "utf8");
    }
  } catch (err) {
    logger.warn(`Failed to write workspace meta files: ${err.message}`);
  }
}

/**
 * Run the autonomous agent loop.
 *
 * @param {object} options
 * @param {string} options.message - User's message
 * @param {Array} [options.conversationHistory] - Previous messages
 * @param {string} [options.systemPrompt] - Custom system prompt
 * @param {string} [options.model] - Model to use
 * @param {string} [options.workspaceDir] - Workspace directory for tools
 * @param {number} [options.maxIterations] - Max tool-calling loops (default: 15)
 * @param {AbortSignal} [options.signal] - Abort controller signal
 * @param {Function} options.onEvent - Callback for streaming events
 * @returns {Promise<{ messages: Array, totalTokens: number }>}
 */
export async function runAgent({
  message,
  images = [],
  context,
  conversationHistory = [],
  systemPrompt,
  model,
  workspaceDir,
  sessionId,
  maxIterations = 15,
  signal,
  onEvent,
}) {
  // Auto-generate workspace plan and chat logs
  await writeWorkspaceMetaFiles(message, conversationHistory, workspaceDir);

  // Build messages array
  const messages = [];

  // Build live environment & targeted context block via ContextSelector
  const contextBlock = ContextSelector.selectContext({
    userPrompt: message,
    sessionId,
    editorContext: context?.editor,
  });

  // System prompt
  messages.push({
    role: "system",
    content: (systemPrompt || DEFAULT_SYSTEM_PROMPT) + contextBlock,
  });

  // Conversation history
  for (const msg of conversationHistory) {
    messages.push(msg);
  }

  // User message (supports multimodal text + image payloads)
  let userMessageContent = message;
  if (images && Array.isArray(images) && images.length > 0) {
    userMessageContent = [
      { type: "text", text: message || "Analyze the attached visual asset / image." },
      ...images.map((img) => ({
        type: "image_url",
        image_url: { url: img },
      })),
    ];
  }
  messages.push({ role: "user", content: userMessageContent });

  // Complete core tool suite for autonomous development
  const coreToolNames = new Set([
    "read_file",
    "write_file",
    "edit_file",
    "delete_file",
    "rename_file",
    "list_files",
    "run_command",
    "web_search",
    "git_status",
    "git_diff",
    "git_log",
    "git_commit",
    "git_push",
    "start_preview",
    "stop_preview",
    "get_preview_status",
    "generate_image",
    "analyze_image",
    "create_plan",
    "update_plan",
    "diagnose_environment",
    "detect_runtimes",
    "repair_application",
    "create_readme",
    "generate_walkthrough",
    "generate_architecture",
  ]);

  const allTools = getToolDefinitions();
  // Include all core tools and dynamically registered MCP / database tools
  const tools = allTools;
  let totalTokens = 0;
  let iteration = 0;

  // Agentic loop
  while (iteration < maxIterations) {
    iteration++;
    const currentTurnId = `turn_${iteration}`;

    logger.debug(`Agent loop iteration ${iteration}/${maxIterations}`);

    onEvent({
      type: "turn_start",
      data: { turn: iteration, maxTurns: maxIterations, turnId: currentTurnId },
    });

    const toolContext = { workspaceDir, sessionId, turnId: currentTurnId, signal };

    let textContent = "";
    let pendingToolCalls = [];
    let gotError = false;

    // Prune/compact context before sending to LLM to prevent context overflow
    const activeMessages = compactContext(messages);

    // Call LLM
    await streamChatCompletion({
      messages: activeMessages,
      tools: tools.length > 0 ? tools : undefined,
      model,
      signal,
      onEvent: (event) => {
        if (signal?.aborted) return;
        switch (event.type) {
          case "text_delta":
            textContent += event.data.content;
            onEvent({ type: "text_delta", data: event.data });
            break;

          case "text_complete":
            // Will handle after the loop
            break;

          case "tool_calls":
            pendingToolCalls = event.data.toolCalls;
            break;

          case "usage":
            totalTokens += event.data.totalTokens || 0;
            break;

          case "error":
            gotError = true;
            let errMsg = event.data?.message || "An unexpected error occurred.";
            if (errMsg.includes("402") || errMsg.includes("credits") || errMsg.includes("in-flight")) {
              errMsg = "⚠️ OpenRouter Credit Limit: OpenRouter requires available credits for 'mistralai/devstral-2512'. Please top up $1 on openrouter.ai/credits or switch to 🟢 Low Usage mode.";
            }
            onEvent({ type: "error", data: { ...event.data, message: errMsg } });
            break;
        }
      },
    });

    if (signal?.aborted) {
      onEvent({ type: "done", data: { totalTokens, iterations: iteration, aborted: true } });
      return { messages, totalTokens, aborted: true };
    }

    if (gotError) break;

    // If we got text and no tool calls → check if LLM generated code intended for a file
    if (textContent && pendingToolCalls.length === 0) {
      // Find all code blocks in the assistant's response
      const codeBlockRegex = /```(?:html|css|js|javascript|python|py|json|sh|bash)?\s*\n([\s\S]+?)```/g;
      const blocks = [];
      let m;
      while ((m = codeBlockRegex.exec(textContent)) !== null) {
        blocks.push(m[1].trim());
      }

      if (blocks.length > 0) {
        // Find filename mentions in prompt or text
        const requestedFileMatch = message.match(/(?:in|into|to|file|create|make)\s+[`"']?([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)[`"']?/i);
        const textFileMatches = Array.from(textContent.matchAll(/(?:file|named|in|into|created?)\s+[`"']?([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)[`"']?/gi)).map(x => x[1].replace(/[`"']/g, ""));

        // If user explicitly asked for a file (like pong.html), prioritize the largest matching code block
        const targetFilename = requestedFileMatch ? requestedFileMatch[1].replace(/[`"']/g, "") : textFileMatches[0] || "index.html";
        const targetCode = blocks.reduce((a, b) => (a.length > b.length ? a : b), blocks[0]);

        logger.info("Auto-saving LLM code block to file", { targetFilename, len: targetCode.length });
        onEvent({
          type: "tool_start",
          data: { id: `auto_${Date.now()}`, name: "write_file", args: { path: targetFilename } },
        });

        const result = await executeTool("write_file", { path: targetFilename, content: targetCode }, toolContext);

        onEvent({
          type: "tool_result",
          data: {
            id: `auto_${Date.now()}`,
            name: "write_file",
            success: result.success,
            output: result.output || result.error,
          },
        });
      }

      messages.push({ role: "assistant", content: textContent });
      onEvent({ type: "text_complete", data: { content: textContent } });
      break;
    }

    // If we got tool calls → execute them
    if (pendingToolCalls.length > 0) {
      // Add assistant message with tool calls
      messages.push({
        role: "assistant",
        content: textContent || null,
        tool_calls: pendingToolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });

      // Execute each tool
      for (const tc of pendingToolCalls) {
        let args = {};
        try {
          args = JSON.parse(tc.arguments || "{}");
        } catch {
          args = {};
        }

        onEvent({
          type: "tool_start",
          data: { id: tc.id, name: tc.name, args },
        });

        const result = await executeTool(tc.name, args, toolContext);

        onEvent({
          type: "tool_result",
          data: {
            id: tc.id,
            name: tc.name,
            success: result.success,
            output: result.output || result.error,
          },
        });

        // Add tool result to conversation
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result.success
            ? result.output
            : `Error: ${result.error}`,
        });
      }

      // Continue loop to get LLM's response after tool results
      continue;
    }

    // No text and no tool calls — something went wrong
    if (!textContent) {
      onEvent({
        type: "error",
        data: { message: "No response from LLM" },
      });
      break;
    }
  }

  // Max iterations reached
  if (iteration >= maxIterations) {
    onEvent({
      type: "error",
      data: {
        message: `Max iterations (${maxIterations}) reached. The task may need to be broken into smaller steps.`,
      },
    });
  }

  onEvent({ type: "done", data: { totalTokens, iterations: iteration } });

  return { messages, totalTokens };
}
