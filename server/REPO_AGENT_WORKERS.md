# ATH IDE Repository Agent Workers

This document describes the asynchronous GitHub coding-agent service. It is a separate worker tier, not an API route that keeps a browser request open.

## Request-to-PR flow

1. The API authenticates the user, loads that user's GitHub connection from the server-side database, verifies repository push permission, pins the base commit SHA, and writes a durable task row.
2. The API enqueues only the opaque task ID and attempt number into the Redis Stream \`ath:repo-agent:jobs\`.
3. One of the independent worker processes claims the stream item, acquires a Redis lease, and loads the task and GitHub credential from shared Postgres.
4. The worker clones the selected commit to a task-specific local workspace. It removes common tracked credential files and the local \`.git\` directory before mounting the code into a Docker sandbox.
5. A context engineer inventories the repository, reads project instruction files, ranks relevant files against the task, and stores a bounded context checkpoint.
6. The pipeline runs planner, coder, tester, reviewer, and up to two repair-coder retries. Role summaries, statuses, verification evidence and attempt checkpoints are persisted to Postgres.
7. Deterministic project checks and an explicit reviewer approval are required before a GitHub branch and draft PR can be created. No automatic merge occurs.
8. Task status and redacted progress events are available to the desktop/mobile web UI and to capability-based share links.

## Required services

A production/multi-worker deployment requires:

- **Postgres** as the shared task, context-round, share-link and comment store.
- **Redis** as the task stream, consumer group, cancellation channel, worker heartbeat registry and lease coordinator.
- One or more dedicated **Linux worker hosts with Docker Engine**. Each worker process runs the same code and can claim any task. It needs Git on the host, the sandbox image, and a writable local workspace root.
- An LLM provider key available to the worker process (for example, \`OPENROUTER_API_KEY\`), because the multi-agent loop runs on the worker, not the API process.

The API and dedicated repository-agent worker can run on the AWS Lightsail host; keep the worker isolated from public ingress. It does not need a local Docker daemon for repository tasks; the dedicated worker hosts do. The existing interactive terminal/preview APIs still have their own runtime and storage constraints documented in [WORKSPACE_RUNTIME.md](./WORKSPACE_RUNTIME.md).

## API process configuration

The API process needs the same shared database and Redis endpoints as the worker:

\`\`\`env
NODE_ENV=production
DATABASE_URL=postgresql://<user>:<password>@<postgres-host>:5432/<database>?sslmode=require
REDIS_URL=rediss://<redis-host>:<port>
PUBLIC_URL=https://<your-ide-domain>
\`\`\`

Keep the existing JWT, GitHub OAuth and LLM configuration in the API environment as appropriate. Do not pass GitHub personal access tokens in browser headers, query strings or queue messages. The worker retrieves each task owner's GitHub token from the shared database.

In production, the task API returns HTTP 503 if Redis or the shared Postgres task store is unavailable. SQLite fallback is supported only for single-worker development.

## Worker host configuration

Build the isolated workspace image from the repository root:

\`\`\`bash
docker build -f server/Dockerfile.workspace -t ath-ide-workspace:local .
\`\`\`

Run each worker host with:

\`\`\`env
NODE_ENV=production
DATABASE_URL=postgresql://<user>:<password>@<postgres-host>:5432/<database>?sslmode=require
REDIS_URL=rediss://<redis-host>:<port>
EXECUTION_RUNTIME=docker
WORKSPACE_ROOT=/var/lib/ath-ide/repo-agent-workspaces
DOCKER_WORKSPACE_IMAGE=ath-ide-workspace:local
DOCKER_WORKSPACE_NETWORK=none
REPO_AGENT_NETWORK=none
DOCKER_WORKSPACE_UID=1000
DOCKER_WORKSPACE_GID=1000
REPO_AGENT_LEASE_MS=120000
REPO_AGENT_MAX_ATTEMPTS=3
OPENROUTER_API_KEY=<worker-llm-key>
\`\`\`

Install dependencies and start the worker from the \`server/\` directory:

\`\`\`bash
npm ci
npm run worker:repo-agent
\`\`\`

Run multiple worker processes/hosts with the same Postgres and Redis. Redis Streams consumer-group claiming, \`XAUTOCLAIM\`, renewable per-task leases, task cancellation and worker heartbeats coordinate the pool. Each worker can use its own local \`WORKSPACE_ROOT\`; a task attempt reclones the pinned GitHub SHA on whichever worker claims it.

The worker must be able to access Docker Engine on its own host. Do not expose the Docker socket to browser-facing or untrusted application processes. Run the worker as a dedicated OS service account, restrict ingress to the API/worker management network, and keep the Postgres/Redis credentials in a secret manager.

## Package installation and network policy

The default sandbox network is \`none\`. The agent receives no GitHub credential and no provider API key. The container has a read-only root, dropped Linux capabilities, no-new-privileges, CPU/memory/PID limits, a bounded tmpfs and a single task-workspace bind mount.

A clean Node/Python/Go/Rust project often needs package downloads before tests can run. To enable that, set \`REPO_AGENT_NETWORK=bridge\` only after the worker host has a firewall or egress proxy that allowlists the required package registries and blocks private address ranges, metadata endpoints and arbitrary destinations. **Docker bridge networking alone is not an egress security boundary.** The implementation deliberately keeps network disabled unless the operator opts in.

If dependencies cannot be installed safely, the quality gate records that verification was blocked and refuses to publish a PR. It does not mark a model-generated response as a successful build.

## Context and quality policy

- Repository inventory is bounded (3,000 entries); retrieved context and project instructions are bounded before entering prompts.
- Common secret/config files are excluded from context retrieval and removed from the task checkout before agent execution.
- Context-engineer, planner, coder, tester, reviewer and repair summaries are persisted by attempt. A retry can reuse bounded summaries from prior attempts.
- A task can make up to three worker attempts by default. A coding attempt can make up to three reviewer/tester cycles with repair rounds.
- A PR is published only when at least one supported deterministic check exists, all selected checks pass, and the reviewer outputs an approval verdict.
- PRs are draft branches only. Human review and merge remain outside the agent.

Current checks are selected from project manifests/scripts (for example, npm/pnpm/yarn test/build/typecheck/lint, pytest, Cargo tests and Go tests). Unknown build systems may need an explicit adapter before they can pass the gate.

## Sharing and mobile access

The web UI provides responsive task/review pages and expiring share links:

- \`view\`: task prompt, redacted activity and draft PR link.
- \`comment\`: view plus comments.
- \`edit\`: view/comment plus submission of a follow-up instruction, which queues a new task under the owner's GitHub connection.

Share tokens are high-entropy bearer capabilities. Only a SHA-256 hash is stored; the raw token is returned to the owner once. Owners can list and revoke links. Default expiration is seven days (up to 30 days). A share link is equivalent to granting the selected role to anyone who possesses it, so treat it like a password.

This is a responsive web experience, not a native iOS/Android app. It shares task state via the same API and does not require the browser tab to remain open while a worker runs.

## Start locally for integration testing

For a single-machine development setup, run Postgres and Redis locally, build the workspace image, and set the API/worker environments to use the same Postgres/Redis. For local SQLite fallback, use a single worker only and set \`NODE_ENV=development\`.

Do not set \`EXECUTION_RUNTIME=docker\` on a hosted API instance that cannot access a Docker Engine and compatible workspace path. In a split API/worker deployment, set Docker mode on the worker process; configure the API for the runtime required by its other endpoints.

## Operational limitations

This is a first cloud-worker vertical slice, not a fully managed SaaS control plane:

- No VM/cluster is provisioned by the application; operators must supply worker hosts, Postgres and Redis.
- There is no native app and no in-browser multi-user live terminal; collaboration is through share roles, progress, comments and follow-up tasks.
- The current retrieval is bounded lexical/path ranking, not a vector database or semantic embedding index.
- The task worker supports multiple processes/hosts, but durable object storage for large workspace artifacts, per-tenant disk quotas, registry egress proxy deployment, automated container orphan sweeping, full job audit/retention policy, and a worker autoscaler remain operational follow-ups.
- Integration tests must be run against disposable Linux Docker workers and real Postgres/Redis before production use.

No paid resource, secret, VM, database or deployment is created by this repository change.
