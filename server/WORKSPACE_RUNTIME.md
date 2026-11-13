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

## Production activation boundaries

The repository now contains an authenticated remote execution worker, per-workspace Docker containers, incremental workspace sync, S3-compatible worker snapshots, preview proxying and tmux-backed remote terminals. These are implemented code paths, not proof that the deployed Lightsail services have every required setting or that the full failure matrix has passed.

The API's normal workspace CRUD still operates on its configured workspace filesystem. The worker's S3 object is a durable snapshot/restore layer for the remote execution workspace; it is not a transactional, shared filesystem for every API replica. Keep `WORKSPACE_STORAGE_ROOT` on durable shared storage for multiple API instances.

Remote execution requires:
- API: `EXECUTION_RUNTIME=remote`, HTTPS `EXECUTION_WORKER_URL`, matching `WORKER_SHARED_SECRET`.
- Execution worker: `EXECUTION_RUNTIME=docker`, private worker ingress, Docker Engine and the matching secret.
- Worker snapshots: `WORKSPACE_OBJECT_STORE_REQUIRED=true` and valid bucket/region/credential configuration. The bucket should be private, encrypted at rest and versioned.

The worker writes snapshots after workspace sync/command execution, periodically during an attached terminal, and on terminal detach. It restores a snapshot when the worker's workspace directory is empty. Snapshots are bounded to 12 MiB, 4,000 files and 2 MiB per file; dependency/build caches are intentionally excluded.

Run `npm run storage:verify-s3` from `server/` on the execution-worker host to
perform a live upload/read-back check using a fresh random workspace key. It
verifies S3 connectivity and snapshot checksum validation. It intentionally
does not delete any existing user workspace; the separate disposable-worker
restore drill must still clear or replace a test workspace directory and call
the authenticated worker pull endpoint.

Run `npm run runtime:verify-terminal-restart` from `server/` on the
execution-worker host with `WORKER_SHARED_SECRET` loaded from the worker
service environment. It connects to the loopback worker API by default
(`WORKER_LOCAL_URL=http://127.0.0.1:8081`), creates a disposable
workspace/terminal, writes a unique marker into tmux, pauses while an operator
restarts the Node execution worker service, then reconnects using the same
terminal UUID and verifies the marker is replayed. Restart only the Node worker
service; leave Docker and the workspace container running. The script then
removes the exact random test container and local workspace directory. The
small S3 snapshot is retained for audit/lifecycle expiry. This is a manual
acceptance test and does not test Docker daemon or VM restart.

Before production sign-off, run the acceptance checks in this document on a disposable user/workspace and a disposable database branch. In particular, prove a worker process restart with the Docker container left running, prove a fresh worker workspace can restore from S3, and prove two different users cannot read or mutate one another's workspaces. A VM/container restart is a different failure domain from restarting the Node worker process.

No VM, cloud resource, secret, or deployment is created by repository code.

## Semantic repository context

Repository-connected coding agents now have a Tree-sitter structural index in
`server/src/services/repoSymbolIndex.js`, integrated into
`server/src/services/repoContextEngine.js`. It parses supported JavaScript,
TypeScript, Python, Rust, Go and Java source files, extracts declarations and
call sites, ranks prompt-relevant symbols, and expands selected files through
one hop of relative imports. Sensitive files and dependency/build directories
are excluded, and indexing is bounded by file-count and per-file-size limits.

The regression suite includes a fixture that checks declaration retrieval,
cross-file call-site retrieval and context formatting. This is structural
code-context retrieval, not a full language server: it does not promise
compiler-grade type resolution, complete reference graphs, or embedding-based
semantic search. Language coverage and large-repository recall should be
benchmarked before describing it as equivalent to IDE-grade LSP intelligence.

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
WebSocket connected to node-pty. The remote execution worker attaches the PTY
to a stable tmux session inside the long-lived per-workspace Docker container.
The browser WebSocket is an attach/detach transport: reconnecting with the same
terminal UUID attaches to the existing tmux session and replays the last 200
terminal lines. This survives a Node execution-worker process restart only
while Docker and the workspace container remain running. It does not restore
arbitrary in-memory processes after the Docker container or VM itself restarts.
Local/API-host PTY behavior remains process-affine.

### Explicit limits

- API workspace CRUD still requires a durable shared filesystem across API replicas.
- S3 snapshots persist bounded remote-worker workspace files, but do not replace
  the API's shared workspace filesystem or provide live multi-writer semantics.
- The workspace event bus uses Redis Pub/Sub when distributed events are enabled;
  Pub/Sub is at-most-once, so clients must reload authoritative files after reconnect.
- Remote tmux PTYs survive a Node worker process restart only if the Docker
  container remains running; Docker/VM restarts terminate live process trees.
- Production acceptance must test workspace ownership, snapshot restore, terminal
  detach/reattach, worker process restart, and the separate Docker/VM restart case.
- Repository code does not provision infrastructure, inject secrets, or prove
  that any cloud service is active.


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

This closes the cross-replica notification gap only. It does not replicate file
contents, terminal state or task state. Shared durable workspace storage and
remote terminal affinity remain separate operational requirements.


## Persistent cloud execution and terminal recovery

The remote API now hashes the full logical workspace identity before sending it
to the worker. The worker keeps a stable directory at
`WORKSPACE_ROOT/remote-users/<workspace-hash>` and reuses the same Docker
container across command requests. API snapshots are synchronized incrementally:
only changed files are replaced, only previously synchronized files that were
deleted by the API are removed, and runtime caches such as `node_modules`,
`.next` and `dist` are preserved. The worker no longer destroys a container
before each command.

Interactive terminal sessions use `tmux` inside the long-lived container. The
browser WebSocket is only an attach/detach transport; disconnecting it leaves
the tmux session and its shell/process tree alive. A new authenticated tunnel
with the same terminal UUID attaches to the existing session and replays the
last 200 terminal lines. This survives an API or execution-worker process
restart while the Docker Engine and workspace container remain available. A
host/VM restart is a different failure domain: files and dependencies persist
on the worker disk, but arbitrary in-memory processes inside a restarted
container cannot be restored automatically.

The worker stores a small atomic manifest of files synchronized from the API,
uses an inter-process lock file for workspace mutations, and applies a
best-effort disk quota after command execution. Enforce hard disk limits at the
worker host/filesystem layer (for example, XFS project quotas) before accepting
untrusted workloads at scale.

## Real-time workspace collaboration

Workspace owners can create time-limited collaboration links from the IDE Share
control. Links are random 256-bit bearer capabilities; only a SHA-256 token hash
is stored. Owners can list and revoke links. The default expiry is seven days
and the maximum is 30 days (links cannot be created without an expiry). Treat the raw invite URL like a password.

- **View** links permit workspace file and directory reads only.
- **Edit** links permit version-checked file creation and updates only. Moving,
  deleting, creating folders, terminal access, command execution, agent tool
  execution, preview control and permission management remain owner-only.
- Collaborators resolve to the owner's workspace root, not a same-named
  workspace under the collaborator's own account.
- WebSocket authentication sends the collaboration capability as a subprotocol,
  not a URL query parameter. Browser HTTP workspace requests attach the token
  only to same-origin `/api/workspace` requests.
- File saves use the workspace SHA-256 version as an ETag / `If-Match` guard.
  A stale write returns HTTP 409. Clean open tabs refresh on remote change;
  dirty tabs retain the local draft and report a conflict rather than silently
  replacing it.
- Presence snapshots are exchanged through the existing Redis event bus every
  15 seconds and expire after 45 seconds. Cross-replica presence therefore
  requires the same private Redis deployment and distributed-events setting
  used by the rest of the workspace event system. File notifications remain
  ephemeral; clients should reload authoritative file contents after reconnect.

The invite API is mounted at `/api/workspace/collaboration/shares`. Run the
normal database migration (`npm run db:migrate` from `server/`) before enabling
this feature on an existing production database. The SQLite development schema
is initialized automatically.

This implementation provides file-level collaborative editing with presence
and optimistic conflict detection. It is not an operational-transform or CRDT
editor: simultaneous edits to the same file are serialized by version checks,
and the later stale save must reload/merge rather than being automatically
merged character-by-character. Validate with two real authenticated browsers,
a disposable shared workspace, and Redis before production sign-off.


### Live S3 restore acceptance (execution-worker host)

The S3 read-back smoke test proves signed object upload/read and checksum
validation, but it does not exercise the worker's actual restore path. For a
full disposable-workspace drill, run from `server/` on the execution-worker
host after loading the worker's existing environment:

```bash
npm run storage:verify-s3
npm run storage:verify-s3-restore
```

The restore drill requires `WORKER_SHARED_SECRET` and the existing
`WORKSPACE_OBJECT_STORE_*` configuration. It sends authenticated requests to
the loopback worker API, creates a random 256-bit workspace identity, syncs a
marker (thereby persisting the S3 snapshot), removes only that exact disposable
local workspace directory, and calls the real `/v1/workspace/pull` endpoint.
It verifies the marker both in the worker response and on disk. The local test
directory is removed afterward; the tiny random-key S3 snapshot is retained for
audit and can be expired by the bucket lifecycle policy. It never targets an
existing user's workspace.

A passing result proves this restore path for the tested worker and bucket
configuration. It does not prove recovery after a full VM or Docker daemon loss.


### Deployed API multi-user isolation acceptance

Run from a trusted operator machine with a production API URL and the API's
existing JWT signing secret loaded into the environment:

```bash
WORKSPACE_API_URL=https://<api-host> JWT_SECRET=<from-api-secret-store> npm run security:verify-multi-user-isolation
```

The script creates two random synthetic JWT identities (no real account data
is read), concurrently writes the same relative filename with different random
contents, verifies each identity reads back only its own content, and deletes
the two test files. It refuses to send tokens over non-local HTTP. The JWT
secret is read from the environment and is never printed. Run only against an
API environment where synthetic JWT identities are permitted by policy.
