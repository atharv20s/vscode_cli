/**
 * Universal Permission Engine.
 * Commands and paths supplied by the LLM are untrusted. DENY > ASK > ALLOW.
 */
import { logger } from "../config/logger.js";
import { eventBus, EVENT_TOPICS } from "../websocket/eventBus.js";

const DENY_COMMAND_PATTERNS = [
  /\brm\b[^\n]*\s-rf\b/i, /\b(format|mkfs|fdisk|parted)\b/i,
  /\bdd\s+if=/i, /:\(\)\s*\{/, /\b(shutdown|reboot|poweroff|halt)\b/i,
  /\bgit\s+reset\s+--hard\b/i, /\bgit\s+push\b[^\n]*--force/i,
  /\b(npm|pnpm|yarn)\s+publish\b/i,
  /\b(drop\s+(database|schema|table)|truncate\s+table)\b/i,
  /\/var\/run\/docker\.sock/i,
  /\b(chmod|chown)\s+(-R\s+)?(777|\+s)\b/i,
];
const SAFE_READ_ONLY_COMMANDS = [
  /^pwd$/, /^git\s+status(?:\s+--short)?$/,
  /^git\s+diff\s+--(?:stat|name-only)$/, /^git\s+branch\s+--show-current$/,
  /^git\s+log\s+-[1-9][0-9]?\s+--oneline$/, /^git\s+rev-parse\s+--show-toplevel$/,
  /^(node|npm|python|python3)\s+--version$/,
];
const SECRET_PATH_PATTERNS = [
  /(^|\/)\.env(?:\.|$)/i, /(^|\/)(id_rsa|id_ed25519|.*\.pem|.*\.key)$/i,
  /(^|\/)\.aws\/credentials$/i, /(^|\/)terraform\.tfstate(?:\.|$)/i,
];
const SENSITIVE_WRITE_PATHS = [
  /^package(?:-lock)?\.json$/i, /^Dockerfile$/i,
  /^\.github\/workflows\//i, /(^|\/)server\/src\/config\//i,
];

export function classifyCommandForPolicy(command, options = {}) {
  if (typeof command !== "string" || !command.trim()) return "DENY";
  const cmd = command.trim();
  if (DENY_COMMAND_PATTERNS.some(p => p.test(cmd))) return "DENY";
  if (options.isolatedRepoAgent) {
    if (/\b(git\s+(push|remote|config)|npm\s+publish|curl|wget|ssh|scp|sftp|nc|netcat|ftp)\b/i.test(cmd)) return "DENY";
    if (/^(npm|pnpm|yarn)\s+(install|ci|test|run\s+(build|test|lint))(\s|$)/i.test(cmd) ||
        /^bash\s+-lc\s+['"]?(npm|pnpm|yarn)\s+(install|ci|test|run\s+(build|test|lint))/i.test(cmd)) return "ALLOW";
  }
  if (/[\n\r;&|<>\x60$]/.test(cmd)) return "ASK";
  return SAFE_READ_ONLY_COMMANDS.some(p => p.test(cmd)) ? "ALLOW" : "ASK";
}

export function classifyFileOperationForPolicy(action, filePath = "") {
  const normalized = String(filePath || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (action === "read" && SECRET_PATH_PATTERNS.some(p => p.test(normalized))) return "DENY";
  if (["delete", "delete_file"].includes(action)) return "ASK";
  if (["write", "edit", "create"].includes(action) && SENSITIVE_WRITE_PATHS.some(p => p.test(normalized))) return "ASK";
  return "ALLOW";
}

class PermissionEngine {
  constructor() { this.pendingRequests = new Map(); this.defaultPolicy = "ASK"; }

  async checkPermission({ resource, action, payload = {}, sessionId = null, turnId = null, workspaceId = "default", timeout = 60000 }) {
    const decision = this._evaluatePolicy(resource, action, payload);
    if (decision === "DENY") {
      logger.warn(`PermissionEngine: DENIED ${resource}.${action}`, { workspaceId, commandLength: typeof payload.command === "string" ? payload.command.length : 0 });
      return { granted: false, decision: "DENY", reason: `Operation blocked by security policy: ${resource}.${action}` };
    }
    if (decision === "ALLOW") return { granted: true, decision: "ALLOW" };

    const permissionId = `perm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    eventBus.publish(EVENT_TOPICS.PERMISSION_REQUESTED, { permissionId, resource, action, payload, expiresAt: Date.now() + timeout },
      { workspaceId, sessionId, turnId, source: "permission", actor: "system" });
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (!this.pendingRequests.has(permissionId)) return;
        this.pendingRequests.delete(permissionId);
        eventBus.publish(EVENT_TOPICS.PERMISSION_RESOLVED, { permissionId, granted: false, reason: "Approval request timed out." },
          { workspaceId, sessionId, turnId, source: "permission", actor: "system" });
        resolve({ granted: false, decision: "ASK", reason: "Interactive permission request timed out." });
      }, timeout);
      this.pendingRequests.set(permissionId, {
        resolve: (granted, reason) => {
          clearTimeout(timer); this.pendingRequests.delete(permissionId);
          eventBus.publish(EVENT_TOPICS.PERMISSION_RESOLVED, { permissionId, granted, reason },
            { workspaceId, sessionId, turnId, source: "permission", actor: "system" });
          resolve({ granted, decision: "ASK", reason: granted ? "Approved by user" : (reason || "Rejected by user") });
        },
        workspaceId, descriptor: { resource, action, payload, permissionId, workspaceId },
      });
    });
  }

  resolvePermission(permissionId, granted, reason = "", workspaceId = null) {
    const pending = this.pendingRequests.get(permissionId);
    if (!pending || pending.workspaceId !== workspaceId) return false;
    pending.resolve(granted, reason);
    logger.info(`PermissionEngine: Resolved [${permissionId}] -> ${granted ? "GRANTED" : "REJECTED"}`);
    return true;
  }

  _evaluatePolicy(resource, action, payload) {
    if (resource === "command" || action === "run_command" || action === "execute")
      return classifyCommandForPolicy(payload.command, { isolatedRepoAgent: payload.isolatedRepoAgent === true });
    if (resource === "file") return classifyFileOperationForPolicy(action, payload.path);
    if (resource === "git" || resource === "github") {
      if (action === "force-push") return "DENY";
      if (action === "push") return "ASK";
      return "ALLOW";
    }
    return this.defaultPolicy;
  }
  listPendingRequests() { return Array.from(this.pendingRequests.values()).map(p => p.descriptor); }
}
export const permissionEngine = new PermissionEngine();
