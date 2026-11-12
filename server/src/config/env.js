/**
 * Environment configuration -- single source of truth for all env vars.
 * Validates required variables on startup.
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

// Load .env from server/ directory, then fall back to project root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

export const config = {
  // Server
  port: parseInt(process.env.PORT || "3001", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  isDev: (process.env.NODE_ENV || "development") === "development",
  publicUrl: process.env.PUBLIC_URL || "",
  logLevel: process.env.LOG_LEVEL || "info",

  // Database (PostgreSQL / Neon / Supabase or SQLite fallback)
  databaseUrl: process.env.DATABASE_URL || "",
  redisUrl: process.env.REDIS_URL || "",

  // LLM Providers and explicit quality tiers
  defaultLlmProvider: (process.env.DEFAULT_LLM_PROVIDER || (process.env.OPENROUTER_API_KEY ? "openrouter" : process.env.MISTRAL_API_KEY ? "mistral" : "openai")).toLowerCase(),
  llmFallbackProviders: (process.env.LLM_FALLBACK_PROVIDERS || "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean),
  openrouterKey: process.env.OPENROUTER_API_KEY || "",
  openrouterBaseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
  openrouterFastModel: process.env.OPENROUTER_FAST_MODEL || "",
  openrouterCodingModel: process.env.OPENROUTER_CODING_MODEL || "",
  openrouterReasoningModel: process.env.OPENROUTER_REASONING_MODEL || "",
  openrouterVisionModel: process.env.OPENROUTER_VISION_MODEL || "",
  mistralKey: process.env.MISTRAL_API_KEY || "",
  mistralFastModel: process.env.MISTRAL_FAST_MODEL || "mistral-small-latest",
  mistralCodingModel: process.env.MISTRAL_CODING_MODEL || "codestral-latest",
  mistralReasoningModel: process.env.MISTRAL_REASONING_MODEL || "mistral-large-latest",
  mistralVisionModel: process.env.MISTRAL_VISION_MODEL || "pixtral-12b-2409",
  openaiKey: process.env.OPENAI_API_KEY || "",
  openaiFastModel: process.env.OPENAI_FAST_MODEL || "",
  openaiCodingModel: process.env.OPENAI_CODING_MODEL || "",
  openaiReasoningModel: process.env.OPENAI_REASONING_MODEL || "",
  openaiVisionModel: process.env.OPENAI_VISION_MODEL || "",
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
  llmContextWindowTokens: Math.max(8192, parseInt(process.env.LLM_CONTEXT_WINDOW_TOKENS || "65536", 10)),
  llmContextBudgetTokens: Math.max(4096, parseInt(process.env.LLM_CONTEXT_BUDGET_TOKENS || "48000", 10)),
  llmOutputReserveTokens: Math.max(1024, parseInt(process.env.LLM_OUTPUT_RESERVE_TOKENS || "8192", 10)),
  llmContextSafetyTokens: Math.max(512, parseInt(process.env.LLM_CONTEXT_SAFETY_TOKENS || "2048", 10)),

  // Tavily Search
  tavilyKey: process.env.TAVILY_API_KEY || "",

  // Auth
  jwtSecret: process.env.JWT_SECRET || "dev-secret-change-me-in-production",
  sessionSecret: process.env.SESSION_SECRET || "dev-session-secret",

  // GitHub OAuth
  githubClientId: process.env.GITHUB_CLIENT_ID || "",
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET || "",

  // Isolated execution runtime (Docker Engine must be available on the worker host)
  executionRuntime: (process.env.EXECUTION_RUNTIME || "disabled").toLowerCase(),
  executionWorkerUrl: (process.env.EXECUTION_WORKER_URL || "").replace(/\/$/, ""),
  workerSharedSecret: process.env.WORKER_SHARED_SECRET || "",
  dockerBinary: process.env.DOCKER_BIN || "docker",
  dockerImage: process.env.DOCKER_WORKSPACE_IMAGE || "ath-ide-workspace:local",
  dockerWorkspaceNetwork: process.env.DOCKER_WORKSPACE_NETWORK || "none",
  repoAgentNetwork: process.env.REPO_AGENT_NETWORK || "none",
  repoAgentTokenKey: process.env.REPO_AGENT_TOKEN_KEY || "",
  dockerWorkspaceUid: parseInt(process.env.DOCKER_WORKSPACE_UID || "1000", 10),
  dockerWorkspaceGid: parseInt(process.env.DOCKER_WORKSPACE_GID || "1000", 10),

  // Workspace (where user files are sandboxed)
  workspaceRoot: (() => {
    const raw = process.env.WORKSPACE_ROOT;
    const defaultLocal = path.resolve(__dirname, "../../workspace");
    if (!raw) return defaultLocal;
    try {
      const resolved = path.resolve(raw);
      import("fs").then(fsMod => {
        if (!fsMod.existsSync(resolved)) {
          fsMod.mkdirSync(resolved, { recursive: true });
        }
      }).catch(() => {});
      return resolved;
    } catch {
      return defaultLocal;
    }
  })(),

  // Remote Cloud Sandbox (Google Cloud / Oracle Cloud / AWS / any Linux host via SSH)
  remoteSandbox: {
    enabled: (
      process.env.REMOTE_ENABLED ||
      process.env.OCI_REMOTE_ENABLED ||
      process.env.REMOTE_SANDBOX_ENABLED ||
      "false"
    ).toLowerCase() === "true",
    host: process.env.REMOTE_HOST || process.env.OCI_HOST || "",
    user: process.env.REMOTE_USER || process.env.OCI_USER || "ubuntu",
    keyPath: process.env.REMOTE_SSH_KEY_PATH || process.env.OCI_SSH_KEY_PATH || "",
    port: parseInt(process.env.REMOTE_PORT || process.env.OCI_PORT || "22", 10),
    workspace: process.env.REMOTE_WORKSPACE || process.env.OCI_WORKSPACE || "/home/ubuntu/agent-workspace",
    dockerContainer: process.env.REMOTE_DOCKER_CONTAINER || process.env.OCI_DOCKER_CONTAINER || "",
  },
};

/**
 * Validate critical configuration on startup.
 * Warns about missing optional keys, errors on missing critical ones.
 */
export function validateConfig() {
  const warnings = [];
  const errors = [];

  if (!config.openrouterKey && !config.openaiKey && !config.mistralKey) {
    warnings.push(
      "No LLM API key found. Set OPENROUTER_API_KEY or OPENAI_API_KEY in your .env file."
    );
  }

  if (!["openrouter","mistral","openai"].includes(config.defaultLlmProvider)) errors.push("DEFAULT_LLM_PROVIDER must be openrouter, mistral or openai.");
  for (const provider of config.llmFallbackProviders) if (!["openrouter","mistral","openai"].includes(provider)) errors.push("Unsupported LLM fallback provider: " + provider);
  if (!config.tavilyKey) {
    warnings.push(
      "TAVILY_API_KEY not set -- web search will be unavailable. Get a free key at https://tavily.com"
    );
  }

  if (!config.githubClientId || !config.githubClientSecret) {
    warnings.push(
      "GitHub OAuth not configured -- GitHub login and integration will be disabled."
    );
  }

  if (config.jwtSecret === "dev-secret-change-me-in-production" && !config.isDev) {
    errors.push(
      "JWT_SECRET must be set in production! Generate a random 32+ character string."
    );
  }

  if (config.llmContextBudgetTokens + config.llmOutputReserveTokens + config.llmContextSafetyTokens >= config.llmContextWindowTokens) {
    errors.push("LLM_CONTEXT_BUDGET_TOKENS + LLM_OUTPUT_RESERVE_TOKENS + LLM_CONTEXT_SAFETY_TOKENS must be smaller than LLM_CONTEXT_WINDOW_TOKENS.");
  }

  if (!["disabled", "docker", "remote"].includes(config.executionRuntime)) {
    errors.push("EXECUTION_RUNTIME must be disabled, docker, or remote.");
  }

  if (config.executionRuntime === "remote") {
    if (!config.executionWorkerUrl) errors.push("EXECUTION_WORKER_URL is required when EXECUTION_RUNTIME=remote.");
    else if (!config.executionWorkerUrl.startsWith("https://")) errors.push("EXECUTION_WORKER_URL must use HTTPS.");
    if (config.workerSharedSecret.length < 32) errors.push("WORKER_SHARED_SECRET must contain at least 32 characters when EXECUTION_RUNTIME=remote.");
  }

  if (!["none", "bridge"].includes(config.dockerWorkspaceNetwork)) {
    errors.push("DOCKER_WORKSPACE_NETWORK must be none or bridge.");
  }
  if (!["none", "bridge"].includes(config.repoAgentNetwork)) {
    errors.push("REPO_AGENT_NETWORK must be none or bridge.");
  }
  if (config.repoAgentTokenKey && !/^[a-f0-9]{64}$/i.test(config.repoAgentTokenKey)) {
    errors.push("REPO_AGENT_TOKEN_KEY must be a 64-character hexadecimal key (32 bytes).");
  }

  if (!Number.isInteger(config.dockerWorkspaceUid) || config.dockerWorkspaceUid < 1 || !Number.isInteger(config.dockerWorkspaceGid) || config.dockerWorkspaceGid < 1) {
    errors.push("DOCKER_WORKSPACE_UID and DOCKER_WORKSPACE_GID must be positive integers.");
  }

  if (config.remoteSandbox.enabled && !config.remoteSandbox.host) {
    errors.push(
      "REMOTE_ENABLED=true but REMOTE_HOST is not set. Provide the cloud VM IP address."
    );
  }

  return { warnings, errors };
}
