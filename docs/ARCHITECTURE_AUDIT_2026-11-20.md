# ATH IDE Architecture Audit — 2026-11-20

## Scope and evidence

This is a source-level audit of the repository's `main` branch at commit
`f0a4c8525d1129ed68dea8eb34118b96e957a5ed`. It is intentionally non-destructive:
no production configuration, credentials, databases, cloud workers, or user
workspace data were changed.

Files inspected:
- `README.md`, root and server package manifests
- `server/src/server.js`
- `server/src/websocket/wsServer.js`
- `server/src/services/agentService.js`
- `server/src/services/agentRuntime/agentRuntime.js`
- `server/src/services/executionService.js`
- `server/src/services/workspaceService.js`
- `server/src/services/remoteExecutionWorker.js`
- `server/src/services/remoteTerminalClient.js`
- `server/src/services/backends/localBackend.js`
- `Agent/core.py`, `Agent/agent.py`, `CLIENT/ath-bridge.js`
- `server/public/index.html`, `server/public/js/agentHUD.js`
- `web/package.json`, `web/app/page.tsx`, `web/lib/api.ts`
- `.github/workflows/ci.yml`, `AGENTS.md`

This audit is based on source inspection, not a local build, test run, browser
session, or live AWS/Neon verification. Findings below distinguish observed
facts from proposed decisions.

## Executive assessment

ATH IDE is not simply a small Node server with an unfinished UI. It has a
substantial Node backend, a separately maintained Next.js frontend, a legacy
static frontend still served by the backend, a Python agent implementation,
and a remote execution-worker integration. The main risk is not a lack of
features; it is having multiple overlapping paths whose production ownership
and acceptance criteria are not yet obvious.

**Do not rewrite or delete the Python agent, static UI, or existing runtime
services as a first move.** First make the active request path and deployment
contract explicit, then migrate one surface at a time with parity tests.

## Findings

### P0 — Frontend ownership is ambiguous (confirmed)

- The backend's catch-all route serves `server/public/index.html` for every
  non-API route.
- The repository also contains a Next.js 15 / React 19 application under
  `web/`, with Monaco and Xterm dependencies and a substantial
  `web/app/page.tsx` implementation.
- The legacy static page loads browser libraries from public CDNs and uses
  `server/public/js/*`; the backend build still syntax-checks these files.

**Impact:** there are two UI implementations with different build/runtime
models. A developer can improve `web/` while the deployed Node server continues
to render the legacy static app. This is the clearest source of frontend
fragmentation and should be resolved before a visual redesign.

**Decision to make:** designate one production frontend and document how it
is deployed and how it reaches the API. Recommended target: Next.js in
`web/`, only after its current feature coverage and auth/share flows are
verified. Keep the legacy app available during migration; do not remove it
until parity and rollback criteria pass.

### P0 — Workspace authority and synchronization need a contract (confirmed)

- `WorkspaceService` resolves and protects paths inside a local workspace root.
- The remote execution client separately collects a bounded workspace snapshot
  and posts it to the worker. The current transfer code has explicit limits:
  4,000 files, 2 MiB per file, and 12 MiB total.
- The remote terminal path calls `syncWorkspaceOnRemote` before opening a
  worker PTY. The remote worker module also exposes a pull path.

**Impact:** this is a snapshot synchronization design, not proof of a single
shared filesystem. The API-side workspace and worker-side workspace can diverge
between sync/pull boundaries. The size limits also mean the transfer mechanism
cannot be treated as transparent support for arbitrary repositories.

**Required work:** document the read/write authority for each runtime mode;
trace every file read/write, shell execution, preview, agent tool, and watcher
path; test conflict behavior, deletions, symlinks, large files, cancellation,
and interrupted sync. Do not label AWS as authoritative until these paths
prove it.

### P0 — Agent orchestration has overlapping entry points (confirmed)

- `server/src/websocket/wsServer.js` routes the browser WebSocket at `/ws`
  and imports `runAgent` from `agentService.js`.
- `agentService.js` contains the core Node agent loop and imports shared
  tool, policy, context, memory, scheduling, and verification services.
- A modular `AgentRuntime` also exists under
  `server/src/services/agentRuntime/`.
- Python agent implementations remain under `Agent/` and `CLIENT/`.

**Impact:** the existence of multiple agent implementations does not by itself
prove all are active, but it makes ownership, parity, and test coverage unclear.
A premature "Node replaces Python" decision could break supported CLI/bridge
workflows.

**Required work:** build a call graph from HTTP/WebSocket/worker/CLI entry
points to actual agent loops. Identify production callers, test callers,
packaging workflows, and dead/compatibility paths. Then choose one canonical
orchestrator and define any remaining Python component as an explicit SDK,
CLI, or specialist worker with a versioned interface.

### P1 — WebSocket topology is simpler than the proposed three-channel split

The inspected server initializes one `ws` WebSocket server at `/ws`. It
routes agent, terminal, file, collaboration/presence, and other events through
a shared connection/event-bus layer. Remote terminal transport is a separate
server-to-worker WebSocket client.

**Impact:** proposing browser endpoints `/terminal`, `/agent`, and `/fs`
would be a protocol redesign, not a cleanup. The current multiplexed gateway
may be intentional and already carries auth, workspace scoping, heartbeat,
and collaboration behavior.

**Recommendation:** keep the current public protocol for now. First document
message schemas, auth/capability handling, workspace scoping, reconnect and
backpressure semantics. Split channels only if measured isolation or
operational requirements justify it, with compatibility tests.

### P1 — Build validation is broad but not equivalent to product acceptance

The server build script contains a long list of `node --check` operations.
The CI workflow also runs server tests, Playwright installation, and syntax
checks for maintenance/verification scripts. This is useful, but syntax checks
do not prove that the production frontend, agent lifecycle, worker tunnel,
workspace sync, or deployment path works end to end.

**Required work:** define a small, repeatable acceptance suite for:
1. login/token refresh and workspace selection;
2. open/edit/save/reload a file;
3. start an interactive terminal and run a command;
4. agent tool call with permission approval and cancellation;
5. remote worker sync, execution, and pull;
6. preview HTTP and WebSocket proxy;
7. restart/reconnect and workspace isolation.

### P1 — Tool-output limits should be evidence-preserving

The proposed output truncation is sensible only if the agent can retrieve
omitted content. Hard truncation can remove error causes, test summaries, or
structured output needed for safe decisions.

**Recommendation:** standardize tool results with `content`, `truncated`,
`totalBytes`, and an opaque continuation handle (or bounded offset/range
retrieval). Preserve exit code, signal, duration, and stderr/stdout distinction.
Never silently discard output that the agent needs to verify a change.

### P2 — Local developer mode already has a starting point

The server package includes `start:demo` / `dev:standalone` scripts and a
standalone demo launcher. The server startup path also supports local SQLite
when running in development and Postgres is not required. This means a
zero-dependency developer path is not a blank-slate feature.

**Required work:** test and document the existing standalone mode before
adding another local-mode switch. Ensure the demo path cannot be mistaken for
production and does not weaken production fail-closed database behavior.

## Recommended implementation sequence

### PR 1 — Audit and observability (this PR)

- Record the current architecture and the risks above.
- Add no runtime behavior changes.
- Use the audit as the baseline for subsequent changes.

### PR 2 — Runtime/deployment truth map

- Add an architecture diagram showing browser, API, database, Redis/event bus,
  execution worker, workspace sync, preview proxy, and agent call paths.
- Document environment variables by component and local/production modes.
- Identify the actual production frontend URL/build/deployment and remove
  ambiguity in deployment documentation.
- Add a smoke-test script that checks configured services without exposing
  secrets.

### PR 3 — Canonical frontend migration (only after parity inventory)

- Inventory all legacy UI features and routes, including auth, workspace share,
  collaboration, terminal, preview, editor, agent chat, inline edits, and
  permissions.
- Map each to the Next.js app and write browser acceptance tests.
- Route production traffic to the selected frontend only after parity passes.
- Retain a documented rollback path; remove legacy assets in a later PR.

### PR 4 — Workspace consistency and worker contract

- Define the authority model for local and remote execution.
- Add explicit sync version/hash manifests and conflict behavior.
- Test deletions, interrupted transfers, concurrent edits, large repositories,
  symlink rejection, and remote-to-local reconciliation.
- Prefer a persistent shared workspace or a robust incremental protocol over
  repeatedly transferring full snapshots where feasible.

### PR 5 — Agent orchestration consolidation

- Produce a caller map for `runAgent`, `AgentRuntime`, Python `Agent`, and
  CLI/bridge entry points.
- Select the canonical loop from evidence, not preference.
- Preserve compatibility through a versioned adapter and regression tests.
- Remove duplicate paths only after proving they are unused.

### PR 6 — Protocol and tool reliability

- Specify the current `/ws` message contract before considering channel
  separation.
- Add bounded output with continuation, structured execution metadata,
  cancellation, and reconnect tests.
- Keep permission checks and workspace scoping consistent across every path.

## Acceptance gates before calling ATH IDE production-ready

- One documented production frontend and one documented agent orchestration
  path for each supported entry point.
- One explicit workspace consistency/authority contract per execution mode.
- CI includes browser-level acceptance for the critical workflows above.
- Worker/API auth, workspace isolation, restart recovery, preview proxy, and
  database restore have repeatable evidence from a non-production environment.
- No destructive cleanup based only on file names, visual appearance, or
  presumed dead code.

## Immediate next step

The next code change should be a focused runtime/deployment truth map, not a
large UI rewrite. It will establish which app and agent paths are actually
deployed, then let the frontend and workspace migrations proceed without
breaking working capabilities.
