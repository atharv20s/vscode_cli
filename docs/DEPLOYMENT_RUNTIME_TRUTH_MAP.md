# ATH IDE deployment and runtime truth map

**Inspection baseline:** `f0a4c8525d1129ed68dea8eb34118b96e957a5ed` on `main`  
**Scope:** source/configuration inspection only. This document does not assert that any cloud service is currently healthy.

## 1. Deployment ownership

| Concern | Confirmed owner in source | Evidence | Operational implication |
|---|---|---|---|
| HTTP API and browser WebSocket gateway | Node/Express process | `server/src/server.js`, `server/src/websocket/wsServer.js` | API and browser WS share the backend deployment. |
| Legacy browser IDE | Express static directory `server/public` | `express.static(publicDir)` and catch-all in `server/src/server.js` | The Lightsail API deployment continues to serve the legacy SPA. |
| Newer IDE frontend | Next.js app under `web/` | `web/package.json`, `web/app/page.tsx`, `web/app/layout.tsx` | It is a separate frontend artifact, not built by the Lightsail script. |
| Frontend-to-API HTTP | Next.js rewrites | `web/next.config.mjs` rewrites `/api/*` and `/preview/*` to `BACKEND_URL` (default localhost:3001) | Production must set the backend origin correctly for the frontend host. |
| Frontend-to-API WebSocket | Browser-side URL selection | `web/components/TerminalPanel.tsx` uses `NEXT_PUBLIC_WS_URL`, otherwise constructs `ws(s)://<hostname>:3001/ws` | HTTP rewrites do not proxy WebSockets. The WS origin must be configured/routed separately. |
| Production Lightsail deployment | GitHub Actions workflow + remote script | `.github/workflows/lightsail-deploy.yml`, `scripts/deploy-lightsail.sh` | Operator-triggered deploy checks out `main`, deploys server dependencies/build, and restarts API, execution-worker and repo-agent units. |
| Frontend build in Lightsail deployment | Not present | Deployment script has no `web/` build/install/start step | This workflow does not publish the Next.js frontend. |
| Frontend CI | Not present in inspected CI workflow | `.github/workflows/ci.yml` only installs/builds/tests `server/` | The current CI gate does not prove the Next app type-checks or builds. |

## 2. Request and execution paths

### Browser HTTP
1. Browser loads either the legacy static SPA from Express or the separately hosted Next.js app.
2. Next.js API calls use relative `/api/*` URLs through its rewrite to `BACKEND_URL`.
3. Express mounts authentication, agent, workspace, collaboration and GitHub routes under `/api`.

### Browser WebSocket and terminal
1. The Next terminal component opens a browser WebSocket to `NEXT_PUBLIC_WS_URL` or its current host-derived fallback.
2. The backend WebSocket gateway multiplexes agent, file, terminal, preview and collaboration message types over `/ws`.
3. In remote execution mode, the API opens a separate worker-side terminal connection; that is an API-to-worker hop, not the browser socket.

### Preview
- HTTP preview requests are handled by Express `/preview` middleware and, in remote mode, proxied to the execution worker.
- Next.js rewrites `/preview/*` to the backend.
- Preview WebSocket upgrades are handled separately by the backend upgrade handler. A frontend deployment must not assume an ordinary HTTP rewrite proves HMR/WebSocket support.

## 3. Workspace and authority boundary

- API-side workspace operations are resolved through `WorkspaceService` and its path boundary checks.
- Remote execution currently synchronizes bounded workspace snapshots to the worker. The source inspection does not establish a single shared filesystem or prove conflict/deletion semantics.
- Do not designate the API copy or worker copy as authoritative until the sync contract is tested under interrupted transfers, concurrent edits, deletions, symlinks and worker restarts.
- The worker lifecycle registry proposed in PR #64 is currently a separate draft PR; do not treat its registry as production-integrated based on its existence alone.

## 4. Agent ownership boundary

- The browser WebSocket gateway calls the Node agent service.
- A modular Node `AgentRuntime` also exists.
- Python agent and CLI bridge paths remain in the repository.
- The inspected call paths do not justify deleting the Python path or replacing the active Node orchestration. First inventory entry points, imports, tests and deployment consumers.

## 5. Environment and deployment contract to make explicit

| Variable / setting | Consumer | Required decision |
|---|---|---|
| `BACKEND_URL` | Next.js rewrite config | Set to the reachable backend origin for the deployed frontend; never rely on localhost outside a colocated dev setup. |
| `NEXT_PUBLIC_WS_URL` | Browser terminal component | Set to the browser-reachable secure WebSocket URL ending in the backend `/ws` route. |
| Backend port | Express server and WS | Confirm the actual listener port and proxy mapping match the frontend HTTP and WS origins. |
| `executionRuntime` / remote worker config | Backend runtime | Confirm local vs remote execution mode and the authenticated worker endpoint contract. |
| Production DB/Redis configuration | API and workers | Verify service identity and connectivity independently; health of the API alone is not proof of worker DB identity. |
| Preview public origin | Preview capability/proxy flow | Keep preview origin separate from the authenticated IDE origin as intended by the backend comments and configuration. |

Do not add secrets or real production values to this document or CI logs.

## 6. Current gaps and acceptance gates

1. **Frontend reproducibility:** `web/package.json` exists, but a `web/package-lock.json` was not present in this inspected tree. Add a lockfile before using `npm ci` or claiming deterministic installs.
2. **Frontend CI:** add a dedicated job for install, type-check and production build after the lockfile and required build-time environment contract are settled.
3. **Frontend deployment:** choose and document one canonical hosting path (separate Next/Vercel-style host or a deliberate backend-hosted build). Do not silently migrate production traffic.
4. **WebSocket routing:** test the actual browser-origin WS handshake, authentication subprotocol, reconnect and terminal lifecycle through the intended reverse proxy.
5. **Feature parity:** compare legacy SPA and Next app flows before changing the production entry point. Include login/guest bootstrap, workspace CRUD, file read/write/version conflicts, agent streaming/cancel/permissions, terminal, preview, collaboration and GitHub tasks.
6. **Workspace authority:** add integration tests for snapshot push/pull, deleted files, large files, symlinks, concurrent modifications, interrupted sync and worker restart.
7. **Agent ownership:** trace and test all Node/Python/CLI entry points before removing any path.
8. **Production rollout:** use the guarded, manually dispatched Lightsail workflow only after reviewed PRs and explicit operator authorization. This work does not invoke it.

## 7. Safe sequence

- Establish this deployment/runtime map.
- Add reproducible frontend dependency installation and build/type-check CI.
- Build a parity suite against both frontends; fix gaps before selecting the canonical frontend.
- Switch deployment ownership only in a separately reviewed PR with rollback.
- Then prove workspace authority and agent orchestration contracts.
- Finish with end-to-end acceptance and failure/recovery drills.

## Validation statement

This is a source-level map based on the named commit. No dependency installation, local build, browser test, live Redis/Neon check, Lightsail SSH session, production deployment or workspace mutation was performed while authoring it.
