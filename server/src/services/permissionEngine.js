/**
 * Universal Permission Engine
 * 
 * Enforces unified policy checks across Terminal Commands, Filesystem Operations,
 * Git / GitHub Actions, and MCP Tools using the strict hierarchy: DENY > ASK > ALLOW.
 */

import { logger } from "../config/logger.js";
import { eventBus, EVENT_TOPICS } from "../websocket/eventBus.js";

/** @typedef {'ALLOW' | 'ASK' | 'DENY'} PermissionDecision */

/** Dangerous patterns that are always unconditionally DENIED */
const DENY_COMMAND_PATTERNS = [
  /rm\s+-rf\s+\//i,
  /format\s+[a-z]:/i,
  /del\s+\/s\s+\/q\s+[a-z]:\\/i,
  /mkfs/i,
  /dd\s+if=/i,
  /:(){ :|:& };:/,
  /shutdown/i,
  /reboot/i,
  /git\s+push.*--force/i,
  /git\s+reset\s+--hard/i,
];

/** Operations requiring interactive user confirmation (ASK) */
const ASK_COMMAND_PATTERNS = [
  /git\s+push/i,
  /drop\s+database/i,
  /drop\s+table/i,
  /npm\s+publish/i,
];

class PermissionEngine {
  constructor() {
    /** @type {Map<string, { resolve: Function, reject: Function, timer: any, descriptor: object }>} */
    this.pendingRequests = new Map();
    this.defaultPolicy = "ALLOW";
  }

  /**
   * Evaluate a requested tool or system action.
   * 
   * @param {object} params
   * @param {string} params.resource - Resource category ('command', 'file', 'git', 'github', 'mcp', 'preview')
   * @param {string} params.action - Specific action (e.g. 'execute', 'write', 'delete', 'push')
   * @param {object} [params.payload={}] - Action parameters
   * @param {string} [params.sessionId] - Session ID
   * @param {string} [params.turnId] - Agent turn ID
   * @param {string} [params.workspaceId='default']
   * @param {number} [params.timeout=60000] - Interactive approval timeout
   * @returns {Promise<{ granted: boolean, decision: PermissionDecision, reason?: string }>}
   */
  async checkPermission({
    resource,
    action,
    payload = {},
    sessionId = null,
    turnId = null,
    workspaceId = "default",
    timeout = 60000,
  }) {
    // 1. Evaluate Rule Matrix (DENY > ASK > ALLOW)
    const decision = this._evaluatePolicy(resource, action, payload);

    if (decision === "DENY") {
      logger.warn(`PermissionEngine: DENIED ${resource}.${action}`, payload);
      return {
        granted: false,
        decision: "DENY",
        reason: `Operation blocked by security policy: ${resource}.${action}`,
      };
    }

    if (decision === "ALLOW") {
      logger.debug(`PermissionEngine: ALLOWED ${resource}.${action}`);
      return { granted: true, decision: "ALLOW" };
    }

    // 2. Decision is ASK — Request Interactive User Approval
    const permissionId = `perm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    logger.info(`PermissionEngine: Requesting approval [${permissionId}] for ${resource}.${action}`);

    eventBus.publish(EVENT_TOPICS.PERMISSION_REQUESTED, {
      permissionId,
      resource,
      action,
      payload,
      expiresAt: Date.now() + timeout,
    }, {
      workspaceId,
      sessionId,
      turnId,
      source: "permission",
      actor: "system",
    });

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(permissionId)) {
          this.pendingRequests.delete(permissionId);
          eventBus.publish(EVENT_TOPICS.PERMISSION_RESOLVED, {
            permissionId,
            granted: false,
            reason: "Approval request timed out.",
          });
          resolve({
            granted: false,
            decision: "ASK",
            reason: "Interactive permission request timed out.",
          });
        }
      }, timeout);

      this.pendingRequests.set(permissionId, {
        resolve: (granted, reason) => {
          clearTimeout(timer);
          this.pendingRequests.delete(permissionId);
          eventBus.publish(EVENT_TOPICS.PERMISSION_RESOLVED, {
            permissionId,
            granted,
            reason,
          });
          resolve({
            granted,
            decision: "ASK",
            reason: granted ? "Approved by user" : (reason || "Rejected by user"),
          });
        },
        descriptor: { resource, action, payload, permissionId },
      });
    });
  }

  /**
   * Resolve a pending permission request (called via WebSocket or REST).
   * 
   * @param {string} permissionId
   * @param {boolean} granted
   * @param {string} [reason]
   * @returns {boolean}
   */
  resolvePermission(permissionId, granted, reason = "") {
    const pending = this.pendingRequests.get(permissionId);
    if (pending) {
      pending.resolve(granted, reason);
      logger.info(`PermissionEngine: Resolved [${permissionId}] -> ${granted ? "GRANTED" : "REJECTED"}`);
      return true;
    }
    return false;
  }

  /**
   * Evaluate policy rules for given operation.
   * @private
   */
  _evaluatePolicy(resource, action, payload) {
    // 1. Shell Commands
    if (resource === "command" || action === "run_command" || action === "execute") {
      const cmd = payload.command || "";
      for (const pattern of DENY_COMMAND_PATTERNS) {
        if (pattern.test(cmd)) return "DENY";
      }
      for (const pattern of ASK_COMMAND_PATTERNS) {
        if (pattern.test(cmd)) return "ASK";
      }
      return "ALLOW";
    }

    // 2. Filesystem Operations
    if (resource === "file") {
      if (action === "delete" || action === "delete_file") {
        return "ASK";
      }
      return "ALLOW";
    }

    // 3. Git Operations
    if (resource === "git" || resource === "github") {
      if (action === "push" || action === "force-push") {
        return action === "force-push" ? "DENY" : "ASK";
      }
      return "ALLOW";
    }

    // 4. Default fallback
    return this.defaultPolicy;
  }

  /**
   * List currently pending permission requests.
   */
  listPendingRequests() {
    return Array.from(this.pendingRequests.values()).map((p) => p.descriptor);
  }
}

export const permissionEngine = new PermissionEngine();
