/**
 * Universal Permission Engine.
 * Commands emitted by an LLM are untrusted: unknown commands require approval.
 */
import { logger } from "../config/logger.js";
import { eventBus, EVENT_TOPICS } from "../websocket/eventBus.js";

/** @typedef {'ALLOW' | 'ASK' | 'DENY'} PermissionDecision */
const DENY_COMMAND_PATTERNS = [
  /\brm\b[^\n]*\s-rf\b/i,
  /\b(format|mkfs|fdisk|parted)\b/i,
  /\bdd\s+if=/i,
  /:\(\)\s*\{/,
  /\b(shutdown|reboot|poweroff|halt)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+push\b[^\n]*--force/i,
  /\b(npm|pnpm|yarn)\s+publish\b/i,
  /\b(drop\s+(database|schema|table)|truncate\s+table)\b/i,
  /\/var\/run\/docker\.sock/i,
];
const SAFE_READ_ONLY_COMMANDS = [
  /^pwd$/,
  /^git\s+status(?:\s+--short)?$/,
  /^git\s+diff\s+--(?:stat|name-only)$/,
  /^git\s+branch\s+--show-current$/,
  /^git\s+log\s+-[1-9][0-9]?\s+--oneline$/,
  /^git\s+rev-parse\s+--show-toplevel$/,
  /^(node|npm|python|python3)\s+--version$/,
];

export function classifyCommandForPolicy(command, { isolatedRepoAgent = false } = {}) {
  if (typeof command !== "string" || !command.trim()) return "DENY";
  const cmd = command.trim();
  for (const pattern of DENY_COMMAND_PATTERNS) if (pattern.test(cmd)) return "DENY";
  // Repo-agent jobs run in disposable per-task Docker workspaces with networking
  // forcibly disabled. Permit build/test commands there; this cannot grant host access.
  if (isolatedRepoAgent) return "ALLOW";
  // Never auto-approve shell composition, substitutions, redirects or multiline input.
  if (!/[\n\r;&|<>\u0060$]/.test(cmd) &&
      SAFE_READ_ONLY_COMMANDS.some(pattern => pattern.test(cmd))) return "ALLOW";
  return "ASK";
}

export function classifyFileOperationForPolicy(action, inputPath = "", { isolatedRepoAgent = false } = {}) {
  const filePath = String(inputPath || "").replace(/\\/g, "/").toLowerCase();
  const pathSegments = filePath.split("/").filter(Boolean);
  const secretPath = pathSegments.some(segment =>
    /^\.env(?:$|\.)/i.test(segment) ||
    /^(id_rsa|id_ed25519)(?:$|\.)/i.test(segment) ||
    /^(credentials|secrets?|service-account|firebase-adminsdk[^/]*|\.npmrc|\.pypirc|\.netrc|kubeconfig)(?:$|\.)/i.test(segment) ||
    /\.(pem|key|p8|p12|pfx|jks|tfstate)$/i.test(segment)
  );
  if (action === "read" && secretPath) return "DENY";
  if (isolatedRepoAgent) return secretPath ? "DENY" : "ALLOW";
  if (action === "delete" || action === "delete_file") return "ASK";
  const sensitiveProjectFile = /(^|\/)\.github\/workflows\//i.test(filePath) ||
    /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|dockerfile|docker-compose[^/]*|\.env(?:$|\.)|\.npmrc)$/i.test(filePath) ||
    /(^|\/)server\/src\/config\/env\.js$/i.test(filePath);
  if ((action === "write" || action === "edit") && (secretPath || sensitiveProjectFile)) return "ASK";
  return "ALLOW";
}

class PermissionEngine {
  constructor() {
    /** @type {Map<string, { resolve: Function, reject: Function, timer: any, descriptor: object }>} */
    this.pendingRequests = new Map();
    this.defaultPolicy = "ASK";
  }

  async checkPermission({ resource, action, payload = {}, sessionId = null, turnId = null, workspaceId = "default", timeout = 60000 }) {
    const policyPayload = {
      ...payload,
      isolatedRepoAgent: payload.isolatedRepoAgent === true || String(workspaceId || "").startsWith("repo-agent-"),
    };
    const decision = this._evaluatePolicy(resource, action, policyPayload);
    if (decision === "DENY") {
      logger.warn(`PermissionEngine: DENIED ${resource}.${action}`, { workspaceId, command: policyPayload.command });
      return { granted: false, decision: "DENY", reason: `Operation blocked by security policy: ${resource}.${action}` };
    }
    if (decision === "ALLOW") {
      logger.debug(`PermissionEngine: ALLOWED ${resource}.${action}`);
      return { granted: true, decision: "ALLOW" };
    }

    const permissionId = `perm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    logger.info(`PermissionEngine: Requesting approval [${permissionId}] for ${resource}.${action}`);
    eventBus.publish(EVENT_TOPICS.PERMISSION_REQUESTED, {
      permissionId, resource, action, payload: policyPayload, expiresAt: Date.now() + timeout,
    }, { workspaceId, sessionId, turnId, source: "permission", actor: "system" });

    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (!this.pendingRequests.has(permissionId)) return;
        this.pendingRequests.delete(permissionId);
        eventBus.publish(EVENT_TOPICS.PERMISSION_RESOLVED, {
          permissionId, granted: false, reason: "Approval request timed out.",
        }, { workspaceId, sessionId, turnId, source: "permission", actor: "system" });
        resolve({ granted: false, decision: "ASK", reason: "Interactive permission request timed out." });
      }, timeout);
      this.pendingRequests.set(permissionId, {
        resolve: (granted, reason) => {
          clearTimeout(timer);
          this.pendingRequests.delete(permissionId);
          eventBus.publish(EVENT_TOPICS.PERMISSION_RESOLVED, { permissionId, granted, reason },
            { workspaceId, sessionId, turnId, source: "permission", actor: "system" });
          resolve({ granted, decision: "ASK", reason: granted ? "Approved by user" : (reason || "Rejected by user") });
        },
        workspaceId,
        descriptor: { resource, action, payload, permissionId, workspaceId },
      });
    });
  }

  resolvePermission(permissionId, granted, reason = "", workspaceId = null) {
    if (typeof granted !== "boolean" || typeof permissionId !== "string" || !permissionId) return false;
    const pending = this.pendingRequests.get(permissionId);
    if (pending && pending.workspaceId === workspaceId) {
      pending.resolve(granted, reason);
      logger.info(`PermissionEngine: Resolved [${permissionId}] -> ${granted ? "GRANTED" : "REJECTED"}`);
      return true;
    }
    return false;
  }

  _evaluatePolicy(resource, action, payload) {
    if (resource === "command" || action === "run_command" || action === "execute") return classifyCommandForPolicy(payload.command, { isolatedRepoAgent: payload.isolatedRepoAgent === true });
    if (resource === "file") return classifyFileOperationForPolicy(action, payload.path, { isolatedRepoAgent: payload.isolatedRepoAgent === true });
    if (resource === "git") {
      if (action === "force-push") return "DENY";
      if (payload.isolatedRepoAgent) return ["push", "pull", "clone"].includes(action) ? "DENY" : "ALLOW";
      if (["push", "commit", "pull", "clone", "branch-create", "branch-delete", "branch-switch"].includes(action)) return "ASK";
      return "ALLOW";
    }
    if (resource === "github") {
      if (action === "force-push" || payload.isolatedRepoAgent) return "DENY";
      if (["push", "create_pr", "create_repo", "create_issue"].includes(action)) return "ASK";
      return "ALLOW";
    }
    return this.defaultPolicy;
  }

  listPendingRequests() {
    return Array.from(this.pendingRequests.values()).map(p => p.descriptor);
  }
}
export const permissionEngine = new PermissionEngine();
