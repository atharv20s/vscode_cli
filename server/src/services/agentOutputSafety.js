/**
 * High-confidence output credential redaction for agent responses and tool output.
 *
 * This is a defense-in-depth output filter, not a guarantee that every secret
 * format can be recognized. Secret-file access and command permissions remain
 * the primary controls.
 */
const REDACTION_RULES = [
  {
    name: "private-key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi,
    replacement: "[REDACTED PRIVATE KEY]",
  },
  { name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED AWS ACCESS KEY]" },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: "[REDACTED GITHUB TOKEN]" },
  { name: "openai-style-token", pattern: /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{24,}\b/g, replacement: "[REDACTED API TOKEN]" },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: "[REDACTED JWT]" },
  {
    name: "credential-assignment",
    pattern: /(^|\n)([ \t]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|CLIENT[_-]?SECRET|JWT[_-]?SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY)\s*[:=]\s*)([^\r\n]+)/gi,
    replacement: "$1$2[REDACTED]",
  },
];

export function redactSensitiveOutput(value) {
  const source = typeof value === "string" ? value : String(value ?? "");
  let text = source;
  const redactions = [];
  for (const rule of REDACTION_RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) {
      rule.pattern.lastIndex = 0;
      text = text.replace(rule.pattern, rule.replacement);
      redactions.push(rule.name);
    }
  }
  return { text, redactions, changed: text !== source };
}
