# ATH IDE agent orchestration ownership map

**Baseline:** `f0a4c8525d1129ed68dea8eb34118b96e957a5ed` on `main`.  
**Purpose:** establish actual entry points before merging agent loops or removing Python/legacy code.

## Confirmed request path

```text
Browser
  -> server/src/websocket/wsServer.js
      -> import { runAgent } from server/src/services/agentService.js
          -> LLM service + registered Node tools
          -> TaskMemory / ToolScheduler / EvidenceVerifier / PermissionEngine
          -> onEvent callback streams results to the browser
```

Evidence:
- `server/src/websocket/wsServer.js` imports `runAgent` from `../services/agentService.js`.
- The `chat` message handler calls `handleChat`, which invokes `runAgent(...)`.
- `server/src/services/agentService.js` exports the active `runAgent` function and imports the Node tool registry and shared policy/context services.
- `server/src/server.js` initializes the built-in Node tools during startup.

## Parallel implementations and their status

| Component | What source confirms | What is not yet proven |
|---|---|---|
| Node `agentService.js` | Active browser WS chat path; owns the main LLM/tool loop. | Whether every repo-agent/background task uses this exact loop or a specialized worker path. |
| Node `AgentRuntime` | A modular class exists under `server/src/services/agentRuntime/agentRuntime.js`; it composes shared memory/scheduler/verifier/evaluator/controller services. | No direct `new AgentRuntime` use was found in the inspected `agentService.js` file. Its complete caller set and test coverage need a repository-wide import/call graph. |
| Python `Agent/core.py` | A separate async agent implementation with its own tool registry, settings, prompts and LLM client exists. | Current production entry points, packaging, CI coverage and whether any external user workflow depends on it. |
| Python `Agent/agent.py` | A second, simpler Python agent class/prompt implementation exists. | Whether this is an active compatibility API or obsolete duplicate code. |
| `CLIENT/ath-bridge.js` | A local workstation WebSocket bridge connects to the cloud gateway and advertises local execution capabilities. | Whether the bridge is used in production and whether its command execution path is still supported and secured end-to-end. |
| Repo-agent worker | A separate systemd service is restarted by the Lightsail deploy script; package scripts expose `worker:repo-agent`. | Its exact orchestration implementation, data ownership, restart/reclaim semantics and relationship to browser chat. |

## Consolidation principles

1. Preserve the active `runAgent` browser path until a replacement proves event, permission, cancellation, context and persistence parity.
2. Treat `AgentRuntime` as a candidate orchestration core, not as the active runtime merely because its class exists.
3. Do not delete Python modules based on absence of imports from the Node browser path. First trace Python entry points, CLI scripts, packaging, workflows, documentation and external callers.
4. Keep the local workstation bridge distinct from cloud worker execution; its trust boundary and capabilities are different.
5. Consolidate policy, tool execution, memory and verification behind stable interfaces only after tests exist for both the current and target orchestration.
6. Avoid two sources of truth for permission decisions. The eventual runtime should call one policy engine and one workspace authority contract.
7. Keep task correlation identifiers, cancellation, durable state and event ordering stable through any migration.

## Required evidence before deleting or merging paths

- [ ] Repository-wide import/call graph for `runAgent`, `AgentRuntime`, Python `Agent` classes and bridge entry points.
- [ ] CI matrix for Node agent tests and Python agent tests (where Python is supported).
- [ ] Golden tests for tool schemas, tool result normalization, permission denial and cancellation.
- [ ] Streaming event compatibility tests, including partial output and provider failure.
- [ ] Conversation/task persistence and workspace isolation tests.
- [ ] Background repo-agent restart/reclaim and idempotency tests.
- [ ] A migration plan with rollback and a period where old and new paths can be compared safely.

## Validation

This map is based on source inspection only. It does not claim the Python agent is unused, does not instantiate either agent, and does not make runtime changes.
