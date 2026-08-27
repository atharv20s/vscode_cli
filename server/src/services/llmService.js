/**
 * Multi-Provider LLM Service with Multimodal Vision Support & Intelligent Failover
 *
 * Wraps the OpenAI SDK to support multiple LLM providers:
 * - Mistral AI Direct (Codestral, Mistral Small/Large, Pixtral Vision)
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
    id: "mistral-small-latest",
    openrouterId: "openrouter/free",
    name: "Mistral Small (Fast / Efficient)",
    tier: "low",
    provider: "mistral",
    temperature: 0.2,
    maxTokens: 4096,
    supportsTools: true,
    multimodal: false,
  },
  devstral: {
    id: "codestral-latest",
    openrouterId: "openrouter/free",
    name: "Codestral AI (Full Agent & Coding)",
    tier: "medium",
    provider: "mistral",
    temperature: 0.3,
    maxTokens: 8192,
    supportsTools: true,
    multimodal: false,
  },
  "devstral-high": {
    id: "mistral-large-latest",
    openrouterId: "openrouter/free",
    name: "Mistral Large (Deep Reasoning)",
    tier: "high",
    provider: "mistral",
    temperature: 0.5,
    maxTokens: 8192,
    supportsTools: true,
    multimodal: true,
  },
  vision: {
    id: "pixtral-12b-2409",
    openrouterId: "openrouter/free",
    name: "Pixtral Vision (Multimodal)",
    tier: "medium",
    provider: "mistral",
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
function getClient(provider = "mistral") {
  const mistralKey = config.mistralKey || process.env.MISTRAL_API_KEY;
  const openrouterKey = config.openrouterKey || process.env.OPENROUTER_API_KEY;

  if (provider === "mistral" && mistralKey) {
    return new OpenAI({
      apiKey: mistralKey,
      baseURL: "https://api.mistral.ai/v1",
    });
  }

  if (provider === "openrouter" || (!mistralKey && openrouterKey)) {
    return new OpenAI({
      apiKey: openrouterKey,
      baseURL: config.openrouterBaseUrl || "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/atharv20s/vscode_cli",
        "X-Title": "Agentic CLI",
      },
    });
  }

  if (provider === "openai" && config.openaiKey) {
    return new OpenAI({
      apiKey: config.openaiKey,
      baseURL: "https://api.openai.com/v1",
    });
  }

  if (provider === "ollama") {
    return new OpenAI({
      apiKey: "ollama",
      baseURL: config.ollamaBaseUrl,
    });
  }

  // Fallback to whichever key exists
  const activeKey = mistralKey || openrouterKey || config.openaiKey || "dev-key";
  const baseUrl = mistralKey ? "https://api.mistral.ai/v1" : "https://openrouter.ai/api/v1";
  return new OpenAI({ apiKey: activeKey, baseURL: baseUrl });
}

/**
 * Send a streaming chat completion request to the LLM.
 */
export async function streamChatCompletion({ messages, tools, model, onEvent, signal }) {
  let preset = MODEL_PRESETS[model] || MODEL_PRESETS["devstral"];

  // Auto-switch to vision model if any message contains image data
  const hasImages = messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === "image_url"));
  if (hasImages && preset && !preset.multimodal) {
    logger.info("Multimodal images detected in request -- switching to Vision-capable model");
    preset = MODEL_PRESETS["vision"];
  }

  const hasMistralKey = Boolean(config.mistralKey || process.env.MISTRAL_API_KEY);
  let provider = hasMistralKey ? "mistral" : "openrouter";
  let modelId = hasMistralKey ? preset.id : preset.openrouterId || "openrouter/free";

  let client = getClient(provider);

  const kwargs = {
    model: modelId,
    messages,
    stream: true,
    max_tokens: preset?.maxTokens || 4096,
    temperature: preset?.temperature !== undefined ? preset.temperature : 0.4,
  };

  if (tools && tools.length > 0) {
    kwargs.tools = tools;
    kwargs.tool_choice = "auto";
  }

  logger.info("LLM request initiated", { model: modelId, provider, messageCount: messages.length });

  try {
    let response;
    try {
      response = await client.chat.completions.create(kwargs, { signal });
    } catch (createErr) {
      if (signal?.aborted) return;
      logger.warn(`Primary LLM (${modelId} via ${provider}) failed: ${createErr.message}. Attempting fallback...`);

      // Fallback 1: If Codestral/Mistral Large fails, fallback to mistral-small-latest
      if (provider === "mistral" && modelId !== "mistral-small-latest") {
        kwargs.model = "mistral-small-latest";
        response = await client.chat.completions.create(kwargs, { signal });
      } else if (config.openrouterKey) {
        // Fallback 2: Try OpenRouter
        provider = "openrouter";
        client = getClient("openrouter");
        kwargs.model = "openrouter/free";
        response = await client.chat.completions.create(kwargs, { signal });
      } else {
        throw createErr;
      }
    }

    let fullContent = "";
    const toolCallsAcc = {};

    for await (const chunk of response) {
      if (signal?.aborted) break;

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

      // Stream text content
      if (delta.content) {
        fullContent += delta.content;
        onEvent({
          type: "text_delta",
          data: { content: delta.content },
        });
      }

      // Stream tool calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallsAcc[idx]) {
            toolCallsAcc[idx] = {
              id: tc.id || `call_${idx}_${Date.now()}`,
              name: tc.function?.name || "",
              arguments: "",
            };
          }
          if (tc.id) toolCallsAcc[idx].id = tc.id;
          if (tc.function?.name) toolCallsAcc[idx].name += tc.function.name;
          if (tc.function?.arguments) toolCallsAcc[idx].arguments += tc.function.arguments;
        }
      }
    }

    // Assemble tool calls
    const completedToolCalls = Object.values(toolCallsAcc).map((tc) => {
      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(tc.arguments);
      } catch {
        parsedArgs = { raw: tc.arguments };
      }
      return {
        id: tc.id,
        name: tc.name,
        arguments: parsedArgs,
      };
    });

    if (completedToolCalls.length > 0) {
      onEvent({
        type: "tool_calls",
        data: { toolCalls: completedToolCalls },
      });
    } else {
      onEvent({
        type: "text_complete",
        data: { content: fullContent },
      });
    }
  } catch (err) {
    if (signal?.aborted) return;
    logger.error("LLM streaming error", { error: err.message, status: err.status });
    onEvent({
      type: "error",
      data: { message: `AI Engine Error: ${err.message}`, status: err.status },
    });
  }
}

/**
 * Get the list of all available models with metadata.
 */
export function getAvailableModels() {
  return Object.entries(MODEL_PRESETS).map(([key, preset]) => ({
    key,
    id: preset.id,
    name: preset.name,
    tier: preset.tier,
    provider: preset.provider,
    multimodal: preset.multimodal,
    free: true,
  }));
}
