# Guarded AWS Lightsail deployment

The repository includes a **manual-only** GitHub Actions deployment path.
It is intentionally not triggered by pushes or merges: CI validation and a
production rollout are separate operations.

## One-time GitHub configuration

Configure these repository or organization Actions secrets:

- `LIGHTSAIL_SSH_HOST`: Lightsail public DNS name or IP.
- `LIGHTSAIL_SSH_USER`: dedicated deployment user (not root if avoidable).
- `LIGHTSAIL_SSH_PRIVATE_KEY`: private key for that deployment user.
- `LIGHTSAIL_SSH_KNOWN_HOSTS`: pre-verified SSH host-key line(s). Obtain and
  verify the host key out-of-band; do not generate trust with an unverified
  `ssh-keyscan` during the workflow.

Create a GitHub Actions environment named `production`. Configure required
reviewers / deployment protection rules there. The workflow uses strict SSH
host-key checking and does not disable host verification.

## One-time Lightsail host preparation

The tracked service units are:

| Role | Unit |
|---|---|
| API | `ath-ide-server.service` |
| Interactive execution worker | `ath-ide-worker.service` |
| Repository-agent worker | `ath-ide-repo-agent.service` |

The repository-agent unit is provided at
`scripts/ath-ide-repo-agent.service`. On the worker host, install it after
reviewing the unit:

```bash
sudo install -o root -g root -m 0644 scripts/ath-ide-repo-agent.service /etc/systemd/system/ath-ide-repo-agent.service
sudo install -d -o ubuntu -g ubuntu -m 0700 /var/lib/ath-ide/repo-agent-workspaces
sudo install -o root -g root -m 0600 /dev/null /etc/ath-ide/repo-agent.env
sudoedit /etc/ath-ide/repo-agent.env
```

Populate that root-owned environment file with the production values for
`NODE_ENV=production`, `DATABASE_URL`, `REDIS_URL`,
`REPO_AGENT_TOKEN_KEY` (64 hexadecimal characters, identical to the API's
value), one supported LLM provider key, `EXECUTION_RUNTIME=docker`,
`WORKSPACE_ROOT=/var/lib/ath-ide/repo-agent-workspaces`,
`DOCKER_WORKSPACE_IMAGE`, `DOCKER_WORKSPACE_UID`, and
`DOCKER_WORKSPACE_GID`. Keep both `REPO_AGENT_NETWORK=none` and
`DOCKER_WORKSPACE_NETWORK=none`. Do not put credentials in the repository or
in a workflow input.

The unit runs as `ubuntu`, requires the local Docker socket and the `docker`
group, and applies systemd hardening. Docker-group access is effectively
host-administrator access: prefer a dedicated worker instance with no public
application ingress, keep the Docker socket local, and do not colocate this
worker with sensitive services unless the host is treated as a trusted
privileged boundary. The API, execution worker and repo-agent worker must use
the same Postgres database and Redis deployment; compare the repo-agent startup
`databaseIdentity` with the API identity after startup.

After the environment file is populated and Docker is installed:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ath-ide-repo-agent.service
sudo systemctl is-active ath-ide-repo-agent.service
sudo journalctl -u ath-ide-repo-agent.service -n 100 --no-pager
```

The API and execution-worker unit files currently use
`/home/ubuntu/ath-ide/server`, so their corresponding repository checkout
path is `/home/ubuntu/ath-ide`. Confirm the actual path and units on the
instance before running a deployment; do not assume a host matches these
sample unit files.

The Lightsail host must already have:

- A clean Git checkout of this repository on branch `main`, with an
  `origin` remote that can fetch the GitHub main branch.
- Node.js 20+ and npm, Git, curl, systemd, Docker Engine and permission to
  restart the three selected systemd services.
- The API, execution-worker and repository-agent services configured with
  their production environment files and secrets.
- The API health endpoint reachable over HTTPS and the execution worker's
  `/healthz` endpoint reachable locally on the host.
- A tested database backup and backward-compatible migrations. The deploy
  workflow does not create a Neon backup or roll back database schema changes.

## Run a deployment

Open **Actions → ATH IDE — Guarded Lightsail production deploy → Run workflow**.
Select the `main` branch and provide:

- Confirmation: exactly `DEPLOY`.
- Deploy path: absolute path to the existing repository checkout
  (normally `/home/ubuntu/ath-ide` with the checked-in units above).
- API service: `ath-ide-server.service`.
- Execution worker service: `ath-ide-worker.service` (the unit running
  `server/src/worker/executionWorker.js`).
- Repo-agent service: `ath-ide-repo-agent.service` (the unit running
  `server/src/worker/repoAgentWorker.js`).
- API health URL: the actual public HTTPS URL ending in `/api/health`.
- Worker health URL: local URL, normally
  `http://127.0.0.1:8081/healthz`.

The SSH secrets, host key, checkout path, service names and health URL must be
confirmed against the actual host before the workflow is run.

The remote script refuses a dirty checkout, a non-`main` branch, a
non-fast-forward update, non-HTTPS API health URL, or a non-loopback worker
health URL. It fast-forwards the host checkout to the exact fetched
`origin/main` SHA, installs locked server dependencies, runs the server build,
restarts all three services, and waits up to 150 seconds for:

- API health status `ok`, PostgreSQL dialect and connected database.
- Execution-worker health status `ok`, expected role and fresh instance ID.
- All three systemd services to be active.

If a deployment step fails after the update starts, it resets the Git checkout
to the previous SHA, reinstalls dependencies, rebuilds, and attempts to restart
the services. This is a **code rollback attempt**, not a guarantee of recovery:
operator verification is still required. Database migrations and external
state are not rolled back. Keep migrations backward-compatible and take a
verified backup before deploying schema-affecting changes.

## What deployment success does not prove

A successful deployment workflow does not prove S3 restore, terminal recovery,
concurrent multi-user isolation, encrypted Neon restore, historical SQLite
reconciliation, or API/repo-agent database identity equality. Run the
production acceptance suite and the Neon identity/count audit separately.
In particular, capture the repo-agent worker's startup `databaseIdentity`
and compare it with the API health fingerprint; the deployment workflow only
checks that the repo-agent systemd unit is active.

The GitHub Actions workflow named
`ATH IDE — CI (AWS Lightsail production)` is validation-only. The guarded
production deploy is a separate manual workflow and requires the exact
`DEPLOY` confirmation plus configured SSH credentials and a verified host.

No production deployment is performed by CI or by merging a pull request.


### Execution-worker systemd hardening

The checked-in `scripts/ath-ide-worker.service` now runs with a restrictive umask, bounded file descriptors, private temporary storage, read-only system paths, read-only home paths, kernel/control-group protection, no-new-privileges, and a restricted address-family set. It explicitly requires the local Docker socket and the `docker` supplementary group. Docker-group membership is effectively root-equivalent; use a dedicated worker host and never expose the Docker socket over TCP.

The default workspace root should remain under `/var/lib/ath-ide/worker`, outside the protected home directory. If `WORKSPACE_ROOT` is changed to a path under `/home` or another protected location, update the unit with a narrowly scoped `ReadWritePaths=` exception and review it before enabling. After installing the seccomp profile and updated unit, run `systemctl daemon-reload`, restart only in a controlled maintenance window, then inspect a newly created disposable container with `docker inspect`. Unit hardening does not itself prove container seccomp, namespace, or cgroup enforcement.
