# Production agent lifecycle hooks

The JavaScript agent loop supports trusted in-process hooks at these stages:
`before_request`, `after_request`, `before_tool`, `after_tool`,
`on_error`, `on_stream_start` and `on_stream_end`.

Hooks are registered by server code through `registerAgentHook`. They receive
bounded metadata, not user prompt text, raw tool arguments, secrets or tool
output. A hook can deny a request/tool only at the corresponding pre-execution
gate. Hooks cannot grant capabilities or bypass the permission engine.

Observer hook failures are logged and do not interrupt the agent. Critical
pre-execution hook failures fail closed. The browser receives lifecycle status
events for visibility; client-side events are informational and cannot make
authorization decisions.

Example:

```js
registerAgentHook("before_tool", async ({ toolName }) => {
  if (toolName === "run_command" && process.env.ATH_DISABLE_AGENT_SHELL === "1") {
    return { block: true, reason: "Shell execution is disabled by worker policy." };
  }
}, { id: "worker-shell-policy", critical: true });
```

The production agent registers built-in critical hooks for the per-turn tool
budget and server-approved tool allowlist, plus a post-tool audit hook that
records tool name, success and duration without arguments or output.

The hook registry is not a sandbox. Hooks must be trusted server code and
must not evaluate repository content or model-generated JavaScript.
