import { logger } from "../config/logger.js";

const VALID_STAGES = new Set([
  "before_request", "after_request", "before_tool", "after_tool",
  "on_error", "on_stream_start", "on_stream_end",
]);
const hooks = new Map();
let sequence = 0;

/**
 * Register trusted server-side lifecycle code. Only before_request and
 * before_tool hooks may deny execution; hooks cannot grant capabilities.
 */
export function registerAgentHook(stage, handler, options = {}) {
  if (!VALID_STAGES.has(stage)) throw new TypeError("Unsupported agent lifecycle stage.");
  if (typeof handler !== "function") throw new TypeError("Lifecycle hook must be a function.");
  const id = options.id || "hook_" + (++sequence);
  if (hooks.has(id)) throw new Error("Lifecycle hook ID is already registered.");
  hooks.set(id, {
    id,
    stage,
    handler,
    priority: Number.isFinite(options.priority) ? options.priority : 0,
    critical: options.critical === true,
    sequence,
  });
  return () => hooks.delete(id);
}

/**
 * Execute hooks in stable priority order. Observer failures are logged and
 * ignored; a failing critical gate fails closed before request/tool execution.
 */
export async function runAgentHooks(stage, metadata = {}) {
  if (!VALID_STAGES.has(stage)) throw new TypeError("Unsupported agent lifecycle stage.");
  const candidates = [...hooks.values()]
    .filter(hook => hook.stage === stage)
    .sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
  let blocked = false;
  let reason = "";

  for (const hook of candidates) {
    try {
      const result = await hook.handler(Object.freeze({ ...metadata, stage }));
      if ((stage === "before_request" || stage === "before_tool") && result?.block === true) {
        blocked = true;
        reason = typeof result.reason === "string" && result.reason.trim()
          ? result.reason.slice(0, 500)
          : "Blocked by lifecycle policy.";
        break;
      }
    } catch (error) {
      logger.warn("Agent lifecycle hook failed", {
        hookId: hook.id, stage, critical: hook.critical,
        error: error?.message || "Unknown lifecycle hook error",
      });
      if (hook.critical && (stage === "before_request" || stage === "before_tool")) {
        blocked = true;
        reason = "A critical lifecycle policy hook failed; execution was blocked.";
        break;
      }
    }
  }
  return { blocked, reason };
}

export function clearAgentHooks() {
  hooks.clear();
  sequence = 0;
}
