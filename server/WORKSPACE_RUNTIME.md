# Isolated Linux Workspace Runtime

## Architecture

- **Cloud Run API:** authentication, REST/SSE, agent orchestration and workspace metadata.
- **Dedicated Linux worker:** private HTTP service on a VM with Docker Engine; executes untrusted commands inside per-workspace containers.
- **Workspace storage:** must be durable and shared across API instances before production enablement.

Cloud Run cannot access a host Docker Engine or bind-mount its filesystem into sibling containers. Do not set `EXECUTION_RUNTIME=docker` on the Cloud Run API.

## Worker image

Build the sandbox image on the worker host from the repository root:

```bash
docker build -f server/Dockerfile.workspace -t ath-ide-workspace:local .
```

The image includes Node.js 22, Python 3, Git, bash and build tools. Each sandbox has a read-only root filesystem, no Linux capabilities, no-new-privileges, 1 GiB memory, one CPU, 256 PIDs, a 256 MiB /tmp and a workspace-only writable mount. Container networking defaults to `none`.

## Worker process configuration

Run on the dedicated Linux worker host (not Cloud Run):

```env
NODE_ENV=production
EXECUTION_RUNTIME=docker
WORKER_PORT=8081
WORKER_SHARED_SECRET=<same-random-32+-character-secret-as-api>
WORKSPACE_ROOT=/var/lib/ath-ide/worker
DOCKER_WORKSPACE_IMAGE=ath-ide-workspace:local
DOCKER_WORKSPACE_UID=1000
DOCKER_WORKSPACE_GID=1000
DOCKER_WORKSPACE_NETWORK=none
```

Start it from `server/`:

```bash
npm ci
npm run start:worker
```

Expose the worker only behind HTTPS and a restrictive firewall/ingress policy. The API signs each request with HMAC-SHA256 over timestamp, nonce and exact body bytes. The worker checks the signature in constant time, enforces a five-minute timestamp window and rejects replayed nonces. Keep the shared secret in a secret manager; never commit it or put it in a browser.

## Cloud Run API configuration

```env
EXECUTION_RUNTIME=remote
EXECUTION_WORKER_URL=https://<private-worker-domain>
WORKER_SHARED_SECRET=<same-random-32+-character-secret-as-worker>
```

The API delegates non-interactive command execution to `POST /v1/execute`. The current bridge transfers a bounded workspace snapshot (up to 12 MiB and 4,000 files; individual files up to 2 MiB), runs the command in the per-workspace Docker container, and returns the resulting snapshot. It excludes `.git`, `node_modules`, `.next`, `dist`, `build` and `.cache`.

## Important: not production-ready yet

This branch implements the first authenticated execution bridge, not the complete distributed workspace architecture. **Do not enable `EXECUTION_RUNTIME=remote` on production yet.** The current API workspace CRUD, file watchers, preview service and interactive terminal still use API-local filesystem/process assumptions. Cloud Run local disk is ephemeral and instance-local; snapshot transfer alone does not make user workspaces durable or consistent across Cloud Run instances.

Before production activation, complete and test all of the following:

1. Make durable object/shared storage the source of truth for workspace files and route every file CRUD operation through it.
2. Make worker workspace sync incremental and concurrency-safe across multiple worker instances; the current worker lock is process-local.
3. Implement authenticated interactive PTY streaming and container lifecycle/idle cleanup.
4. Implement a secure preview reverse proxy to the isolated worker; production live preview remains disabled.
5. Add disk quotas, per-user concurrency limits, request/response size limits at ingress, worker health/readiness checks, audit logging and backup/restore.
6. Run integration tests on a real disposable Linux Docker host: cross-user filesystem isolation, path/symlink traversal, container escape hardening, cancellation, timeout, network denial, worker restart and concurrent execution.

No VM, cloud resource, secret, or deployment is created by this repository change.

## GitHub repository agent tasks

Repository-connected background coding agents now use a separate Redis Streams worker tier. The API persists the task and enqueues its ID; dedicated Linux workers load the owner's GitHub connection from shared Postgres, clone the pinned repository SHA, run the multi-agent pipeline inside a task-specific Docker sandbox, and publish a draft PR only after deterministic checks and reviewer approval.

See [REPO_AGENT_WORKERS.md](./REPO_AGENT_WORKERS.md) for the API/worker split, Postgres and Redis configuration, worker startup, scaling, context rounds, quality gates, share roles and operational limitations.

Important deployment boundaries:

- Production API/worker task state requires shared Postgres and Redis; SQLite is single-worker development only.
- Each repository worker host must have Docker Engine, Git, the workspace image, and a local writable `WORKSPACE_ROOT`.
- The API enqueues tasks; it does not run repository code inside the browser request process.
- Worker networking is disabled by default. Package registry access requires `REPO_AGENT_NETWORK=bridge` plus a host-level egress firewall or allowlisted proxy. Docker bridge mode alone is not an egress security control.
- No cloud resources, VM, secrets or deployment are provisioned by this repository code.

## Network access

Container networking defaults to `none`. This blocks workspace code from reaching the internet and other host/network services. Package downloads require a deliberate egress design. Do not set `DOCKER_WORKSPACE_NETWORK=bridge` as a shortcut: bridge networking alone is not an egress security boundary.

## Existing local Docker mode

For a self-hosted API and Docker Engine on the same machine only:

```env
EXECUTION_RUNTIME=docker
DOCKER_WORKSPACE_IMAGE=ath-ide-workspace:local
DOCKER_WORKSPACE_UID=1000
DOCKER_WORKSPACE_GID=1000
DOCKER_WORKSPACE_NETWORK=none
```

The API process and Docker daemon must see the same absolute `WORKSPACE_ROOT`. This mode is not compatible with the current Cloud Run deployment.


## Workspace and terminal milestone (ATH IDE runtime v1)

The studio now supports authenticated named workspaces per user. Set
`WORKSPACE_STORAGE_ROOT` to a durable **shared filesystem mount** on every API
instance before production use. Each owner has an opaque SHA-256 directory;
named workspaces live below that owner's `sessions/` directory. Configure
`WORKSPACE_QUOTA_BYTES`, `WORKSPACE_MAX_FILE_BYTES` and
`WORKSPACE_MAX_SESSIONS_PER_USER` to bound storage and workspace count.

File writes are atomic (same-directory temporary file + rename), serialized by
a shared lock file, and guarded by SHA-256 optimistic versions. Editors should
send `If-Match: "<version>"`; stale saves return HTTP 409 instead of silently
overwriting newer edits. New-file creation uses `If-None-Match: *`. The lock
heartbeat prevents an active writer from being mistaken for a stale lock.

The browser terminal uses the MIT-licensed xterm.js package over an authenticated
WebSocket connected to node-pty. Browser JWT authentication is carried in the
WebSocket subprotocol negotiation (not the URL query string), avoiding token
exposure in ordinary reverse-proxy request URL logs. A PTY can detach and reattach using a
workspace-scoped terminal UUID while the owning API/worker process remains
alive; the server replays a bounded recent output buffer on reconnect. Idle
detached PTYs are terminated after `TERMINAL_IDLE_TTL_MS`.

### Explicit limits

- Durable storage currently means a mounted filesystem, not S3/GCS object storage.
- All APIs sharing the same workspace files must mount the same filesystem and
  honor its exclusive-create/rename/mtime semantics.
- The workspace event bus is process-local; cross-replica live file notifications
  still need Redis Pub/Sub or PostgreSQL NOTIFY.
- PTY ownership and output buffers are process-local. Reconnect survives a
  browser disconnect, not a worker restart or a different replica.
- Production terminal/preview routing still needs a worker-affinity or terminal
  broker and an authenticated preview reverse proxy.
- This branch does not provision infrastructure, run migrations against a
  hosted DB, or activate any paid service.


## Redis-backed cross-instance workspace events

The API event bus can fan out workspace notifications between API replicas using
Redis Pub/Sub. Set the same `REDIS_URL` on every API instance. Set
`REQUIRE_DISTRIBUTED_EVENTS=true` in production to make missing or unavailable
Redis a startup failure rather than silently operating with process-local events.

The transport publishes validated event envelopes on the internal
`ath:workspace-events:v1` channel, rejects oversized/malformed messages, and
de-duplicates local Redis echoes by event ID. WebSocket subscribers still scope
events to their authenticated workspace identity. Keep Redis private to the
application network and use TLS (`rediss://`) for managed/shared deployments.

This is notification fan-out, not a durable event log and not a workspace
storage system. Redis Pub/Sub is at-most-once: a replica disconnected during an
event will not replay it. Clients must reload authoritative workspace metadata
and file contents after reconnect. The filesystem or future object-storage
adapter remains the source of truth.

This closes the cross-replica event notification gap only. Interactive PTYs are
still process/worker-affine and do not survive worker restarts; authenticated
preview proxying and shared durable workspace storage remain separate
production blockers.
