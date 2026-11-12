/**
 * Model-aware LLM routing. No silent free-model downgrade: every attempt is
 * explicit, observable and uses a model configured for that provider.
 */
import OpenAI from "openai";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";

export const MODEL_PRESETS = {
  "devstral-low": { tier: "fast", name: "Fast", temperature: 0.2, maxTokens: 4096, multimodal: false },
  devstral: { tier: "coding", name: "Coding", temperature: 0.15, maxTokens: 8192, multimodal: false },
  "devstral-high": { tier: "reasoning", name: "Reasoning", temperature: 0.1, maxTokens: 12288, multimodal: false },
  vision: { tier: "vision", name: "Vision", temperature: 0.2, maxTokens: 4096, multimodal: true },
};
const PROVIDER_MODELS = {
  openrouter: { fast: config.openrouterFastModel, coding: config.openrouterCodingModel, reasoning: config.openrouterReasoningModel, vision: config.openrouterVisionModel },
  mistral: { fast: config.mistralFastModel, coding: config.mistralCodingModel, reasoning: config.mistralReasoningModel, vision: config.mistralVisionModel },
  openai: { fast: config.openaiFastModel, coding: config.openaiCodingModel, reasoning: config.openaiReasoningModel, vision: config.openaiVisionModel },
};
function providerKey(provider) {
  return provider === "openrouter" ? config.openrouterKey : provider === "mistral" ? config.mistralKey : provider === "openai" ? config.openaiKey : null;
}
function getClient(provider) {
  const apiKey = providerKey(provider);
  if (!apiKey) throw new Error("No API key configured for provider " + provider + ".");
  const options = { apiKey };
  if (provider === "openrouter") {
    options.baseURL = config.openrouterBaseUrl;
    options.defaultHeaders = { "HTTP-Referer": "https://github.com/atharv20s/vscode_cli", "X-Title": "ATH IDE" };
  } else if (provider === "mistral") options.baseURL = "https://api.mistral.ai/v1";
  else if (provider === "openai") options.baseURL = "https://api.openai.com/v1";
  else throw new Error("Unsupported LLM provider: " + provider);
  return new OpenAI(options);
}
function resolveTier(model) {
  if (MODEL_PRESETS[model]) return MODEL_PRESETS[model].tier;
  return ["fast","coding","reasoning","vision"].includes(model) ? model : "coding";
}
function resolveAttempts(tier) {
  const providers = [config.defaultLlmProvider, ...config.llmFallbackProviders]
    .filter((value,index,array) => value && array.indexOf(value) === index);
  return providers.map(provider => ({ provider, model: PROVIDER_MODELS[provider]?.[tier] }))
    .filter(item => providerKey(item.provider) && item.model);
}
export async function streamChatCompletion({ messages, tools, model = "coding", onEvent, signal }) {
  let tier = resolveTier(model);
  if (messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image_url"))) tier = "vision";
  const attempts = resolveAttempts(tier);
  if (!attempts.length) {
    const error = new Error("No model is configured for the " + tier + " tier. Configure a provider API key and its tier-specific model. ATH IDE will not silently use a free fallback.");
    error.code = "LLM_MODEL_NOT_CONFIGURED";
    onEvent({ type: "error", data: { message: error.message, code: error.code } });
    return;
  }
  const preset = Object.values(MODEL_PRESETS).find(item => item.tier === tier) || MODEL_PRESETS.devstral;
  const base = { messages, stream: true, max_tokens: preset.maxTokens, temperature: preset.temperature };
  if (tools?.length) { base.tools = tools; base.tool_choice = "auto"; }
  let response = null, selected = null, lastError = null;
  for (const attempt of attempts) {
    if (signal?.aborted) return;
    try {
      logger.info("Starting LLM request", { tier, provider: attempt.provider, model: attempt.model });
      response = await getClient(attempt.provider).chat.completions.create({ ...base, model: attempt.model }, { signal });
      selected = attempt;
      break;
    } catch (error) {
      lastError = error;
      logger.warn("LLM provider attempt failed", { provider: attempt.provider, model: attempt.model, status: error.status, message: error.message });
      if ([400,401,403,404,413,422].includes(error.status)) break;
    }
  }
  if (!response) {
    const error = lastError || new Error("All configured LLM providers failed.");
    onEvent({ type: "error", data: { message: "AI Engine Error: " + error.message, status: error.status } });
    return;
  }
  onEvent({ type: "model_selected", data: { tier, provider: selected.provider, model: selected.model, fallback: attempts[0] !== selected } });
  let fullContent = "";
  const accumulated = {};
  try {
    for await (const chunk of response) {
      if (signal?.aborted) break;
      if (chunk.usage) onEvent({ type: "usage", data: { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens, totalTokens: chunk.usage.total_tokens, provider: selected.provider, model: selected.model } });
      if (!chunk.choices?.length) continue;
      const delta = chunk.choices[0].delta || {};
      if (delta.content) { fullContent += delta.content; onEvent({ type: "text_delta", data: { content: delta.content, text: delta.content } }); }
      for (const call of delta.tool_calls || []) {
        const index = call.index ?? 0;
        if (!accumulated[index]) accumulated[index] = { id: call.id || "call_" + index, name: "", arguments: "" };
        if (call.id) accumulated[index].id = call.id;
        if (call.function?.name) accumulated[index].name = call.function.name;
        if (call.function?.arguments) accumulated[index].arguments += call.function.arguments;
      }
    }
    const toolCalls = Object.values(accumulated).map(call => {
      let args;
      try { args = JSON.parse(call.arguments || "{}"); } catch { args = { raw: call.arguments }; }
      return { id: call.id, name: call.name.trim(), arguments: args, rawArguments: call.arguments };
    });
    if (toolCalls.length) onEvent({ type: "tool_calls", data: { toolCalls } });
    else onEvent({ type: "text_complete", data: { content: fullContent } });
  } catch (error) {
    if (!signal?.aborted) onEvent({ type: "error", data: { message: "AI Engine Error: " + error.message, status: error.status } });
  }
}
export function getAvailableModels() {
  return Object.entries(MODEL_PRESETS).map(([key,preset]) => ({
    key, name: preset.name, tier: preset.tier,
    configured: Object.entries(PROVIDER_MODELS).some(([provider,models]) => providerKey(provider) && models[preset.tier]),
    free: false,
  }));
}
