/**
 * Secret Sanitizer & Output Redactor
 *
 * Scans output streams, tool results, file reads, and error messages to
 * guarantee that credentials, tokens, private keys, and connection strings
 * are redacted before reaching LLM prompts, WebSocket events, or audit logs.
 */

const SECRET_PATTERNS = [
  // GitHub Personal Access Tokens and Fine-Grained Tokens
  { name: "GITHUB_TOKEN", regex: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,255}\b/g },
  { name: "GITHUB_PAT", regex: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g },

  // LLM Provider Keys
  { name: "ANTHROPIC_KEY", regex: /\bsk-ant-(?:api\d+-)?(?:[A-Za-z0-9_-]{20,128})\b/g },
  { name: "OPENAI_KEY", regex: /\bsk-(?!(?:ant)-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,128}\b/g },

  // AWS Access Keys
  { name: "AWS_ACCESS_KEY", regex: /\b(AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/g },

  // JSON Web Tokens (JWT)
  { name: "JWT_TOKEN", regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },

  // Database Connection Strings with Passwords
  {
    name: "DATABASE_CREDENTIALS",
    regex: /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/([^:\s]+):([^@\s\/]+)@/gi,
    replace: (match, proto, user) => `${proto}://${user}:[REDACTED_SECRET]@`,
  },

  // Private Keys
  {
    name: "PRIVATE_KEY",
    regex: /-----BEGIN\s+(?:[A-Z0-9_-]+\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:[A-Z0-9_-]+\s+)?PRIVATE\s+KEY-----/g,
  },

  // Generic API Keys / Tokens in JSON or Key-Value pairs
  {
    name: "SECRET_PAIR",
    regex: /(["']?(?:api[_-]?key|secret|password|token|access[_-]?token)["']?\s*[:=]\s*["'])([^"'\r\n]{4,})(["'])/gi,
    replace: (match, prefix, secret, suffix) => `${prefix}[REDACTED_SECRET]${suffix}`,
  },
];

/**
 * Sanitize a string by replacing detected secret patterns with redaction placeholders.
 * Returns the sanitized string. Handles non-string inputs safely.
 *
 * @param {string} input - Text to sanitize
 * @returns {string} Sanitized output
 */
export function sanitizeSecrets(input) {
  if (typeof input !== "string" || !input) return input;

  let sanitized = input;
  for (const { regex, replace, name } of SECRET_PATTERNS) {
    if (typeof replace === "function") {
      sanitized = sanitized.replace(regex, replace);
    } else {
      sanitized = sanitized.replace(regex, `[REDACTED_${name}]`);
    }
  }
  return sanitized;
}

/**
 * Recursively sanitize strings in objects or arrays (e.g. tool arguments or parsed responses).
 *
 * @param {any} value - Value to sanitize
 * @param {number} [depth=0] - Current recursion depth
 * @returns {any} Sanitized value
 */
export function sanitizeObject(value, depth = 0) {
  if (depth > 8 || !value) return value;
  if (typeof value === "string") return sanitizeSecrets(value);
  if (Array.isArray(value)) return value.map(item => sanitizeObject(item, depth + 1));
  if (typeof value === "object" && value.constructor === Object) {
    const copy = {};
    for (const [key, val] of Object.entries(value)) {
      copy[key] = sanitizeObject(val, depth + 1);
    }
    return copy;
  }
  return value;
}

const SENSITIVE_ENV_KEYS = new Set([
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "DIRECT_DATABASE_URL",
  "POSTGRES_URL",
  "PGPASSWORD",
  "MYSQL_PWD",
  "REDIS_URL",
  "JWT_SECRET",
  "JWT_REFRESH_SECRET",
  "WORKER_SHARED_SECRET",
  "AUTH_SECRET",
  "SESSION_SECRET",
  "COOKIE_SECRET",
  "HASH_SALT",
  "OPENROUTER_API_KEY",
  "MISTRAL_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "TAVILY_API_KEY",
  "GITHUB_TOKEN",
  "REPO_AGENT_TOKEN_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "CLOUDFLARE_API_KEY",
]);

/**
 * Filter host environment variables to strip sensitive database URLs, authentication secrets,
 * and API keys before spawning any child process, shell, or background supervisor.
 *
 * @param {Record<string, string|undefined>} [baseEnv=process.env]
 * @returns {Record<string, string|undefined>} Sanitized environment object
 */
export function sanitizeChildEnv(baseEnv = process.env) {
  const sanitized = { ...baseEnv };
  for (const key of Object.keys(sanitized)) {
    if (SENSITIVE_ENV_KEYS.has(key) || /(?:SECRET|PASSWORD|PRIVATE_KEY|API_KEY|TOKEN)/i.test(key)) {
      delete sanitized[key];
    }
  }
  return sanitized;
}

