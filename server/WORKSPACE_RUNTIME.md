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

The GitHub sidebar now exposes a repository-scoped task flow:

1. The signed-in user selects a repository and base branch. The API looks up that user's GitHub credential in the server-side user record and verifies repository push permission.
2. The API records a task and clones the selected base commit into a unique directory under the user's private workspace.
3. Tracked files matching common secret names (.env files other than examples, .npmrc, .netrc, private-key files) are removed from the task checkout before it is mounted. The local .git directory is also removed.
4. The coding agent receives a task-scoped filesystem service and an explicit tool allowlist. It executes commands in a dedicated Docker container with no network, a read-only container root, dropped capabilities, no-new-privileges, CPU/memory/PID limits and a single task-workspace bind mount.
5. The host compares the task workspace against the pinned GitHub base tree, rejects sensitive paths and oversized diffs, then uses the GitHub Git Data API to create a branch and a **draft pull request**. It never pushes to the base branch or merges.

Enable this only on a self-hosted Linux API worker with Docker Engine and the same local workspace filesystem:

```env
EXECUTION_RUNTIME=docker
DOCKER_WORKSPACE_IMAGE=ath-ide-workspace:local
DOCKER_WORKSPACE_NETWORK=none
DOCKER_WORKSPACE_UID=1000
DOCKER_WORKSPACE_GID=1000
```

Build the image with the command above, install the server dependencies, and start the API on that same worker. Repository tasks require Docker mode; there is no unsandboxed fallback. The default runtime is `disabled`, so the new endpoint returns HTTP 503 until Docker mode is deliberately configured. The task manager limits each account to two simultaneous tasks and stores task status/events in SQLite.

**Current deployment boundary:** this first repository-agent implementation uses the API process's local Docker Engine and its local SQLite/workspace filesystem. It is suitable for a single self-hosted worker / local integration testing; it is not yet a multi-instance Cloud Run or Railway SaaS worker architecture. Do not enable it on a hosted API that cannot see Docker Engine and the same workspace path. Production multi-tenant hosting still needs durable shared task/workspace storage, an external task queue, worker placement/leases, and an authenticated remote worker endpoint that can create a per-task container. No cloud resources are provisioned by this change.

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
