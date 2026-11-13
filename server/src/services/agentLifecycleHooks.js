/**
 * Per-process lifecycle hooks for the JavaScript agent runtime.
 *
 * Before hooks may veto an action. After/error hooks are observational: their
 * failures are collected and must not turn a successful tool operation into a
 * false failure. Hooks receive a per-invocation context object.
 */
export const AGENT_HOOK_TYPES = Object.freeze([
  "before_request", "after_request", "before_tool", "after_tool",
  "on_error", "on_stream_start", "on_stream_end",
]);

const handlers = new Map(AGENT_HOOK_TYPES.map(type => [type, new Set()]));

export class AgentHookError extends Error {
  constructor(message, hookType) {
    super(message);
    this.name = "AgentHookError";
    this.hookType = hookType;
  }
}

export function registerAgentHook(type, handler) {
  if (!handlers.has(type)) throw new TypeError("Unknown agent hook type: " + type);
  if (typeof handler !== "function") throw new TypeError("Agent hook must be a function.");
  handlers.get(type).add(handler);
  return () => unregisterAgentHook(type, handler);
}

export function unregisterAgentHook(type, handler) {
  return handlers.get(type)?.delete(handler) || false;
}

export async function triggerAgentHooks(type, data = {}, { failClosed = false } = {}) {
  const context = { ...data, blocked: false, blockReason: "" };
  const errors = [];
  const registered = handlers.get(type);
  if (!registered) throw new TypeError("Unknown agent hook type: " + type);

  for (const handler of [...registered]) {
    try {
      const result = await handler(context);
      if (result === false) context.blocked = true;
      if (result && typeof result === "object") {
        if (result.blocked === true) context.blocked = true;
        if (typeof result.reason === "string" && result.reason) context.blockReason = result.reason;
      }
    } catch (error) {
      errors.push(error);
      if (failClosed) throw new AgentHookError(
        "Agent action blocked because a required " + type + " hook failed: " + error.message,
        type,
      );
    }
  }

  if (failClosed && context.blocked) {
    throw new AgentHookError(context.blockReason || "Agent action blocked by lifecycle policy.", type);
  }
  return { context, errors, allowed: !context.blocked };
}

export function clearAgentHooks() {
  for (const set of handlers.values()) set.clear();
}
