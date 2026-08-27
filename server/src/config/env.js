/**
 * Environment configuration — single source of truth for all env vars.
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

  // LLM Providers
  openrouterKey: process.env.OPENROUTER_API_KEY || "",
  openrouterBaseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
  openrouterModel: process.env.OPENROUTER_MODEL || "mistralai/devstral-2512",
  mistralKey: process.env.MISTRAL_API_KEY || process.env.OPENROUTER_API_KEY || "ipsMb5hhY03P08dDbbrM9uXlO2I56SY7",

  openaiKey: process.env.OPENAI_API_KEY || "",
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",

  // Tavily Search
  tavilyKey: process.env.TAVILY_API_KEY || "",

  // Auth
  jwtSecret: process.env.JWT_SECRET || "dev-secret-change-me-in-production",
  sessionSecret: process.env.SESSION_SECRET || "dev-session-secret",

  // GitHub OAuth
  githubClientId: process.env.GITHUB_CLIENT_ID || "",
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET || "",

  // Workspace (where user files are sandboxed)
  workspaceRoot: process.env.WORKSPACE_ROOT || path.resolve(__dirname, "../../workspace"),

  // Remote Sandbox (Oracle Cloud Infrastructure / SSH / Docker)
  remoteSandbox: {
    enabled: (process.env.OCI_REMOTE_ENABLED || process.env.REMOTE_SANDBOX_ENABLED || "false").toLowerCase() === "true",
    host: process.env.OCI_HOST || process.env.REMOTE_HOST || "",
    user: process.env.OCI_USER || process.env.REMOTE_USER || "ubuntu",
    keyPath: process.env.OCI_SSH_KEY_PATH || process.env.REMOTE_KEY_PATH || "",
    port: parseInt(process.env.OCI_PORT || process.env.REMOTE_PORT || "22", 10),
    workspace: process.env.OCI_WORKSPACE || process.env.REMOTE_WORKSPACE || "/home/ubuntu/agent-workspace",
    dockerContainer: process.env.OCI_DOCKER_CONTAINER || process.env.REMOTE_DOCKER_CONTAINER || "",
  },
};

/**
 * Validate critical configuration on startup.
 * Warns about missing optional keys, errors on missing critical ones.
 */
export function validateConfig() {
  const warnings = [];
  const errors = [];

  if (!config.openrouterKey && !config.openaiKey) {
    warnings.push(
      "No LLM API key found. Set OPENROUTER_API_KEY or OPENAI_API_KEY in your .env file."
    );
  }

  if (!config.tavilyKey) {
    warnings.push(
      "TAVILY_API_KEY not set — web search will be unavailable. Get a free key at https://tavily.com"
    );
  }

  if (!config.githubClientId || !config.githubClientSecret) {
    warnings.push(
      "GitHub OAuth not configured — GitHub login and integration will be disabled."
    );
  }

  if (config.jwtSecret === "dev-secret-change-me-in-production" && !config.isDev) {
    errors.push(
      "JWT_SECRET must be set in production! Generate a random 32+ character string."
    );
  }

  return { warnings, errors };
}
