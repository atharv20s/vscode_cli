# Guarded AWS Lightsail deployment

The repository now includes a **manual-only** GitHub Actions deployment path.
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
reviewers / deployment protection rules there if available to the repository.
The workflow uses strict SSH host-key checking and does not disable host
verification.

The Lightsail host must already have:

- A clean Git checkout of this repository on branch `main`, with an
  `origin` remote that can fetch the GitHub main branch.
- Node.js 20+ and npm, Git, curl, systemd, and permission to restart the three
  selected systemd services.
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
- Deploy path: absolute path to the existing repository checkout.
- API service: actual API systemd unit name.
- Execution worker service: actual unit running
  `server/src/worker/executionWorker.js` (not the repo-agent service).
- Repo-agent service: actual unit running
  `server/src/worker/repoAgentWorker.js`.
- API health URL: public HTTPS URL ending in `/api/health`.
- Worker health URL: local URL, normally
  `http://127.0.0.1:8081/healthz`.

Do not guess service names or the checkout path. Confirm them on the host first.

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

A successful workflow does not prove S3 restore, terminal recovery, concurrent
multi-user isolation, encrypted Neon restore, historical SQLite reconciliation,
or API/repo-agent database identity equality. Run the production acceptance
suite and the Neon identity/count audit separately. In particular, capture the
repo-agent worker's startup `databaseIdentity` and compare it with the API
health fingerprint; the deployment workflow only checks that the repo-agent
systemd unit is active.

No production deployment has been performed by adding this workflow. It can
run only after the SSH secrets, host key, production environment protection,
checkout path and actual systemd unit names are configured.
