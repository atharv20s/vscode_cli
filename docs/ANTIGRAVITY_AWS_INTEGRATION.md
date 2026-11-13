# Antigravity AWS integration contract

This document describes how to connect the existing ATH IDE code to the provisioned Lightsail host. It intentionally contains placeholders only; never commit real credentials.

## 1. Important: API and worker need different runtime modes

The API and execution worker are separate Node processes and must not share one identical `EXECUTION_RUNTIME` value:

- API process: `EXECUTION_RUNTIME=remote`. It calls the authenticated execution worker through `EXECUTION_WORKER_URL`.
- Worker process: `EXECUTION_RUNTIME=docker`. It owns Docker containers and listens on `WORKER_PORT=8081`.

Use separate systemd EnvironmentFile files (for example `/etc/ath-ide/api.env` and `/etc/ath-ide/worker.env`) or systemd Environment overrides. Do not put both modes in the same shared environment file.

## 2. API process environment

Required for remote execution:

```dotenv
NODE_ENV=production
EXECUTION_RUNTIME=remote
EXECUTION_WORKER_URL=https://YOUR_TLS_HOST/worker
WORKER_SHARED_SECRET=REPLACE_WITH_ONE_RANDOM_64_HEX_CHARACTER_SECRET
PUBLIC_URL=https://YOUR_TLS_HOST
PREVIEW_PUBLIC_URL=https://YOUR_TLS_HOST
```

The API client signs worker requests with HMAC-SHA256. The worker URL must be HTTPS; do not weaken this check to use public plaintext HTTP.

## 3. Worker process environment

```dotenv
NODE_ENV=production
EXECUTION_RUNTIME=docker
WORKER_PORT=8081
WORKER_SHARED_SECRET=THE_SAME_RANDOM_64_HEX_CHARACTER_SECRET
WORKSPACE_ROOT=/home/ubuntu/ath-ide/worker-data
DOCKER_WORKSPACE_IMAGE=ath-ide-workspace:local
DOCKER_WORKSPACE_NETWORK=ath-ide-internal
```

The worker shared secret must match the API process exactly. Generate it once in Antigravity's secret manager and inject it into both services; never commit or print it in logs.

## 4. S3 snapshot environment

The worker process needs these variables:

```dotenv
WORKSPACE_OBJECT_STORE_REQUIRED=true
WORKSPACE_OBJECT_STORE_BUCKET=ath-ide-workspace-snapshots-758371668629
WORKSPACE_OBJECT_STORE_REGION=ap-south-1
WORKSPACE_OBJECT_STORE_ACCESS_KEY_ID=INJECT_FROM_SECRET_STORE
WORKSPACE_OBJECT_STORE_SECRET_ACCESS_KEY=INJECT_FROM_SECRET_STORE
```

The IAM principal should be restricted to the snapshot bucket and only the required object operations (at minimum `s3:GetObject` and `s3:PutObject`; add list/delete only if a feature explicitly needs them). Keep the bucket private and enable default encryption and versioning. The code uses the AWS S3 regional endpoint when `WORKSPACE_OBJECT_STORE_ENDPOINT` is omitted.

## 5. Reverse proxy and firewall

- Expose only the HTTPS Studio entry point publicly.
- Keep API port 3001 and worker port 8081 private/loopback or restrict them to trusted sources.
- Terminate TLS at Nginx and proxy the authenticated `/worker/` path to `http://127.0.0.1:8081/`, preserving the worker request path and WebSocket upgrades.
- Configure `EXECUTION_WORKER_URL` to the HTTPS Nginx origin plus the matching worker path prefix.
- Do not expose the worker's unauthenticated `/healthz` endpoint to the public internet.

## 6. Deployment verification

After injecting environment variables and restarting the two services, verify:

1. API health and worker health from the host.
2. API-to-worker HMAC authentication (a signed workspace pull).
3. A workspace file sync writes an S3 object under `workspaces/<sha256-workspace-id>/snapshot.json`.
4. Destroy the worker workspace directory/container and pull again; the snapshot restores the files.
5. A terminal session survives WebSocket detach/reattach.
6. Preview HTTP and WebSocket/HMR requests pass through the TLS reverse proxy.

Do not report S3 persistence as verified from a successful API health check alone. Confirm an actual object upload and restore.

## 7. Resource guardrails

The provisioned host has 2 vCPU and 2 GB RAM. Keep parallel coding-agent concurrency at two or lower, enforce Docker CPU/memory/PID limits, and monitor swap usage during dependency installation and builds.
