# Frontend parity gates before production cutover

**Baseline:** `f0a4c8525d1129ed68dea8eb34118b96e957a5ed` on `main`.  
**Decision:** keep the legacy Express-served SPA as the production fallback until the Next.js app passes the same user-visible acceptance flows.

## Current topology

- Legacy frontend: `server/public/index.html` and its scripts/styles, served by Express static middleware and the catch-all route in `server/src/server.js`.
- New frontend: Next.js app under `web/`, with the IDE page in `web/app/page.tsx`, API client in `web/lib/api.ts`, and terminal in `web/components/TerminalPanel.tsx`.
- HTTP API: Next.js rewrites `/api/*` and `/preview/*` to `BACKEND_URL`.
- WebSocket: terminal uses `NEXT_PUBLIC_WS_URL` or a host-derived fallback. HTTP rewrites alone do not establish WebSocket proxy support.
- The guarded Lightsail deployment currently installs/builds `server/` and restarts backend units; it does not build or publish `web/`.

## Required parity matrix

| Capability | Legacy SPA | Next.js app evidence | Required acceptance test before cutover |
|---|---|---|---|
| Initial load and guest authentication | Existing static SPA bootstrap | `initialize()` calls `/api/auth/guest` when no access token exists | Fresh browser profile obtains guest session; invalid/expired refresh is handled without a reload loop. |
| Token refresh | Legacy auth client | `web/lib/api.ts` single-flight refresh | Concurrent 401s trigger one refresh; retry uses rotated token; failed refresh clears both tokens. |
| Workspace sessions | Existing workspace UI | Session list, create and change in `web/app/page.tsx` | Create, switch, reload, and verify each workspace remains isolated. |
| File explorer and editor | Monaco/legacy editor scripts | Next page uses Monaco and `/api/workspace/files`, `/file` | Browse nested dirs; read, edit, save; verify version conflict on stale write; reload saved content. |
| Agent chat | Legacy agent HUD and multiplexed WS | Next page sends agent chat over backend API/WS integration | Stream response; cancel active request; verify owner-only execution and denied collaborator path. |
| Conversation history | Legacy conversation UI | Next page loads and selects conversations | Reload latest conversation; switch histories; ensure user/workspace scoping. |
| Terminal | Legacy xterm UI | `TerminalPanel.tsx` opens authenticated `/ws` and sends terminal lifecycle events | Browser-origin WSS handshake; terminal init/input/resize/exit; reconnect after worker restart; no duplicate PTYs. |
| Preview | Legacy preview controls | Next page stores preview URL; backend handles `/preview` and upgrade | Start/stop preview; asset requests and HMR WebSocket work through intended proxy; capability token is not leaked. |
| GitHub integration/tasks | Legacy GitHub controls | Next page loads repos and agent tasks | OAuth/configured integration, repo selection, task creation/status, and error handling. |
| Collaboration/presence | Legacy collaboration UI | Not yet proven feature-parity from the inspected Next page | Invite, collaborator permissions, presence, file updates, share-token handling and terminal/agent denial behavior. |
| Responsive/accessibility | Legacy UI | Next app has a distinct layout and controls | Keyboard-only navigation, focus management, mobile viewport, contrast and screen-reader labels. |

## Cutover gates

- [ ] Add a reproducible `web/package-lock.json` (or explicitly select and pin another package manager).
- [ ] Add CI for frontend dependency install, TypeScript type-check and Next.js production build.
- [ ] Add browser tests for each row above, using disposable test users/workspaces.
- [ ] Test both frontends against the same backend contract and fixture data.
- [ ] Validate the deployed frontend's HTTP API origin and secure WebSocket origin separately.
- [ ] Demonstrate preview/HMR routing through the intended reverse proxy.
- [ ] Compare all collaboration and permission boundaries; do not treat visual similarity as feature parity.
- [ ] Keep the legacy frontend available for rollback until the new frontend passes production smoke tests.

## Explicit non-goals

This document does not migrate the legacy UI, remove static assets, change the Express catch-all, change Vercel/Lightsail settings, or switch production traffic. The Next.js frontend should become canonical only in a separate reviewed change after these gates pass.

## Validation

This is an acceptance specification based on source inspection. No Playwright run, frontend build, type-check, production traffic switch or live deployment was performed.
