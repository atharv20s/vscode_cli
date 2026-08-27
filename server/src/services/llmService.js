/**
 * Multi-Provider LLM Service with Multimodal Vision Support
 *
 * Wraps the OpenAI SDK to support multiple LLM providers:
 * - Mistral AI (Codestral, Mistral Large, Pixtral Vision)
 * - OpenRouter (proxies Claude, GPT-4o, Gemini, Llama)
 * - OpenAI Direct
 * - Ollama Local
 *
 * Handles streaming, tool calling, multimodal image payload formatting, and token tracking.
 */

import OpenAI from "openai";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";

/** Available core models and Vision models */
export const MODEL_PRESETS = {
  "devstral-low": {
    id: "mistralai/devstral-2512:free",
    name: "Codestral 2501 (Fast Mode)",
    tier: "low",
    provider: "openrouter",
    temperature: 0.2,
    maxTokens: 4096,
    supportsTools: true,
    multimodal: false,
  },
  devstral: {
    id: "mistralai/devstral-2512:free",
    name: "Devstral / Codestral (Code Generation)",
    tier: "medium",
    provider: "openrouter",
    temperature: 0.5,
    maxTokens: 8192,
    supportsTools: true,
    multimodal: false,
  },
  "devstral-high": {
    id: "mistralai/devstral-2512:free",
    name: "Devstral High (Deep Reasoning & Architecture)",
    tier: "high",
    provider: "openrouter",
    temperature: 0.7,
    maxTokens: 8192,
    supportsTools: true,
    multimodal: true,
  },
  vision: {
    id: "google/gemini-2.0-flash-exp:free",
    name: "Gemini 2.0 Flash (Multimodal Vision)",
    tier: "medium",
    provider: "openrouter",
    temperature: 0.3,
    maxTokens: 4096,
    supportsTools: true,
    multimodal: true,
  },
};

/**
 * Get the OpenAI client configured for a specific provider.
 * @param {string} provider - 'mistral', 'openrouter', 'openai', or 'ollama'
 * @returns {OpenAI}
 */
function getClient(provider = "openrouter") {
  // If provider is mistral but we have an OpenRouter key, use OpenRouter!
  if (provider === "mistral" && config.mistralKey && !config.mistralKey.startsWith("sk-or-")) {
    return new OpenAI({
      apiKey: config.mistralKey,
      baseURL: "https://api.mistral.ai/v1",
    });
  }

  switch (provider) {
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
        apiKey: config.openrouterKey || config.mistralKey,
        baseURL: config.openrouterBaseUrl || "https://openrouter.ai/api/v1",
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
 * @param {Array} options.messages - Conversation messages (can contain multimodal content arrays)
 * @param {Array} [options.tools] - Tool definitions
 * @param {string} [options.model] - Model preset name or raw model ID
 * @param {Function} options.onEvent - Callback for streaming events
 * @returns {Promise<void>}
 */
export async function streamChatCompletion({ messages, tools, model, onEvent }) {
  // Resolve model
  let preset = MODEL_PRESETS[model];

  // Auto-switch to vision model if any message contains image data and current model lacks vision
  const hasImages = messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === "image_url"));
  if (hasImages && preset && !preset.multimodal) {
    logger.info("Multimodal images detected in request — switching to Vision-capable model");
    preset = MODEL_PRESETS["vision"];
  }

  const modelId = preset ? preset.id : model || config.openrouterModel || "mistralai/devstral-2512:free";
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

  logger.debug("LLM request", { model: modelId, provider, messageCount: messages.length, hasImages });

  try {
    let response;
    try {
      response = await client.chat.completions.create(kwargs);
    } catch (createErr) {
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
