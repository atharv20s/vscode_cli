/**
 * Multi-Provider LLM Service
 *
 * Wraps the OpenAI SDK to support multiple LLM providers:
 * - OpenRouter (default — proxies Claude, GPT, Llama, Mistral)
 * - OpenAI Direct
 * - Ollama Local
 *
 * Handles streaming, tool calling, and token usage tracking.
 */

import OpenAI from "openai";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";

/** Available single core model with Usage Tiers */
export const MODEL_PRESETS = {
  "devstral-low": {
    id: "codestral-latest",
    name: "Codestral 2501 (🟢 Fast Mode)",
    tier: "low",
    provider: "mistral",
    temperature: 0.2,
    maxTokens: 4096,
    supportsTools: true,
  },
  devstral: {
    id: "codestral-latest",
    name: "Devstral / Codestral (🟡 Full Code Generation)",
    tier: "medium",
    provider: "mistral",
    temperature: 0.5,
    maxTokens: 8192,
    supportsTools: true,
  },
  "devstral-high": {
    id: "mistral-large-latest",
    name: "Mistral Large (🔴 Deep Reasoning / Architecture)",
    tier: "high",
    provider: "mistral",
    temperature: 0.7,
    maxTokens: 8192,
    supportsTools: true,
  },
};

/**
 * Get the OpenAI client configured for a specific provider.
 * @param {string} provider - 'mistral', 'openrouter', 'openai', or 'ollama'
 * @returns {OpenAI}
 */
function getClient(provider = "mistral") {
  switch (provider) {
    case "mistral":
      return new OpenAI({
        apiKey: config.mistralKey || config.openrouterKey,
        baseURL: "https://api.mistral.ai/v1",
      });
    case "openai":
      return new OpenAI({
        apiKey: config.openaiKey,
        baseURL: "https://api.openai.com/v1",
      });
    case "ollama":
      return new OpenAI({
        apiKey: "ollama",
        baseURL: config.ollamaBaseUrl,
      });
    case "openrouter":
    default:
      return new OpenAI({
        apiKey: config.openrouterKey,
        baseURL: config.openrouterBaseUrl,
        defaultHeaders: {
          "HTTP-Referer": "https://github.com/atharv20s/vscode_cli",
          "X-Title": "Agentic CLI",
        },
      });
  }
}

/**
 * Send a streaming chat completion request to the LLM.
 *
 * @param {object} options
 * @param {Array} options.messages - Conversation messages
 * @param {Array} [options.tools] - Tool definitions
 * @param {string} [options.model] - Model preset name or raw model ID
 * @param {Function} options.onEvent - Callback for streaming events
 * @returns {Promise<void>}
 */
export async function streamChatCompletion({ messages, tools, model, onEvent }) {
  // Resolve model
  const preset = MODEL_PRESETS[model];
  const modelId = preset ? preset.id : model || config.openrouterModel;
  const provider = preset ? preset.provider : "openrouter";

  const client = getClient(provider);

  const kwargs = {
    model: modelId,
    messages,
    stream: true,
    max_tokens: preset?.maxTokens || 1200,
    temperature: preset?.temperature !== undefined ? preset.temperature : 0.5,
  };

  if (tools && tools.length > 0) {
    kwargs.tools = tools;
    kwargs.tool_choice = "auto";
  }

  logger.debug("LLM request", { model: modelId, provider, messageCount: messages.length });

  try {
    let response;
    try {
      response = await client.chat.completions.create(kwargs);
    } catch (createErr) {
      // If 402 credit limit hit, auto-retry with compact token ceiling
      if (createErr.status === 402 || createErr.message?.includes("credits")) {
        logger.warn("OpenRouter credit headroom tight — retrying with max_tokens: 300");
        kwargs.max_tokens = 300;
        response = await client.chat.completions.create(kwargs);
      } else {
        throw createErr;
      }
    }

    let fullContent = "";
    const toolCallsAcc = {};

    for await (const chunk of response) {
      // Usage info (some providers send it on the last chunk)
      if (chunk.usage) {
        onEvent({
          type: "usage",
          data: {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          },
        });
      }

      if (!chunk.choices || chunk.choices.length === 0) continue;

      const choice = chunk.choices[0];
      const delta = choice.delta;

      // Text content
      if (delta && delta.content) {
        fullContent += delta.content;
        onEvent({ type: "text_delta", data: { content: delta.content } });
      }

      // Tool calls (accumulate across chunks)
      if (delta && delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCallsAcc[idx]) {
            toolCallsAcc[idx] = { id: tc.id || `call_${Date.now()}_${idx}`, name: "", arguments: "" };
          }
          if (tc.id) toolCallsAcc[idx].id = tc.id;
          if (tc.function?.name) toolCallsAcc[idx].name = tc.function.name;
          if (tc.function?.arguments) toolCallsAcc[idx].arguments += tc.function.arguments;
        }
      }
    }

    // Emit accumulated tool calls or final text once after stream ends
    const pendingToolCalls = Object.values(toolCallsAcc).filter((t) => t.name);
    if (pendingToolCalls.length > 0) {
      onEvent({ type: "tool_calls", data: { toolCalls: pendingToolCalls } });
    } else if (fullContent) {
      onEvent({ type: "text_complete", data: { content: fullContent } });
    }
  } catch (err) {
    logger.error("LLM error", { error: err.message, model: modelId });
    onEvent({ type: "error", data: { message: err.message } });
  }
}

/**
 * List all available models.
 * @returns {Array}
 */
export function getAvailableModels() {
  return Object.entries(MODEL_PRESETS).map(([key, preset]) => ({
    key,
    ...preset,
  }));
}
