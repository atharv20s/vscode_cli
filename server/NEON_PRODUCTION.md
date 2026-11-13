# Neon PostgreSQL production rollout

## Status

This document is an operator runbook, not evidence that a Neon project has been provisioned. Do not mark the database deployed until the connection, schema, application persistence, restart, and recovery checks below pass.

## Important architecture audit (current main)

The application currently has two persistence paths:

- `server/src/db/database.js` is the primary synchronous SQLite store. Authentication, users, sessions, and conversations use this module.
- `server/src/db/postgres.js` initializes a PostgreSQL schema and pool. The repository-agent task store and distributed repository-agent worker use PostgreSQL; LLM budget accounting can also use it.
- The API currently catches an initial PostgreSQL connection failure and falls back to SQLite. That is unsafe for a multi-instance production deployment because the API can appear healthy while repository-agent durability is unavailable.
- The schema is created at startup with `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE` statements. There is not yet a versioned, repeatable migration ledger for this schema.
- The worker and API must use the same Neon database/branch. A local SQLite file on each host is not a shared database.

**Consequently, provisioning Neon alone does not complete the application database migration.** The primary auth/session/conversation data path still needs a deliberate SQLite-to-PostgreSQL adapter and a verified data migration before SQLite can be retired.

## Neon project setup

1. Create a dedicated production project in the Neon Console. Choose a region close to the Lightsail deployment (Mumbai/India region if available in the account; otherwise choose the nearest supported region and measure latency).
2. Use a dedicated production branch and database. Keep development/test data on a separate branch/project.
3. Create a least-privilege application role. Do not use the Neon owner role for routine application traffic if a restricted role can be used.
4. Copy both connection strings from **Connect**:
   - pooled endpoint (hostname contains `-pooler`) for long-running application query traffic: `DATABASE_URL`
   - direct endpoint (no `-pooler`) for schema migrations, dumps and restores: `DIRECT_DATABASE_URL`
5. Keep Neon-required TLS parameters (normally `sslmode=require`; preserve `channel_binding=require` when supplied).
6. Store secrets only in the Lightsail service environment/secret manager. Never commit a connection URL, password, or `.env` file.

Official guidance: https://neon.com/docs/connect/connection-pooling and https://neon.com/docs/get-started/connect-neon.

## Deployment environment

Set the same production `DATABASE_URL` on the API service and repository-agent worker service. Use the pooled URL for application traffic. Set `DIRECT_DATABASE_URL` only for migration/backup operations. Keep `NODE_ENV=production`.

Do not put either URL in GitHub Actions logs, command-line arguments, shell history, or chat. When updating systemd environment files, restrict permissions (for example, root-owned mode 0600), then restart the API and repo-agent worker in a controlled maintenance window.

Before restarting production, verify that a tested rollback/backup exists. Do not remove or overwrite the existing SQLite file; retain it read-only until the PostgreSQL migration is reconciled and signed off.

## Required engineering work before cutover

- [x] Replace the SQLite-only user/auth/session/conversation repository functions with a PostgreSQL-backed implementation (or an explicit repository abstraction with both adapters).
- [x] Convert SQLite-specific SQL and synchronous transaction call sites to parameterized PostgreSQL queries and asynchronous transaction boundaries.
- [x] Make the API fail startup in production if `DATABASE_URL` is missing or PostgreSQL initialization fails; never silently fall back to per-host SQLite in production.
- [x] Ensure the API and repository-agent worker initialize the same schema and use the same database.
- [x] Introduce numbered, idempotent migrations and a schema-version table. Keep migration execution separate from normal pooled application startup; run migrations using the direct URL.
- [x] Add migration tooling that enumerates every non-internal SQLite table, fails on missing PostgreSQL tables or unmapped columns, preserves imported IDs, and runs atomically. It currently verifies exact per-table row counts; row-by-row content checksums are still outstanding.
- [ ] Run integration tests against a disposable PostgreSQL database for signup/login, session ownership, conversations, repo-agent task leases, share permissions and usage reservations. A pool-reconnect persistence check is implemented in `scripts/test-neon-end-to-end.mjs`, but has not yet been rerun after the latest changes; it does not replace API/worker restart tests.
- [x] Add database health/readiness reporting that distinguishes PostgreSQL connectivity from process liveness. Do not expose connection strings or credentials in health output.

## Persistence acceptance test

After the adapter and migrations are implemented:

1. Run migrations using the direct connection URL and record the schema version (`npm run db:migrate`).
2. Migrate existing SQLite records if upgrading an existing instance (`npm run db:migrate:sqlite`).
3. Create a dedicated test user, session, conversation, and repository-agent task through the real API.
4. Confirm each row exists using a read-only database query, checking user ownership and foreign-key relationships.
5. Restart the API service and verify login/session/conversation reads.
6. Restart the repository-agent worker and verify it can reclaim/continue a leased task from the shared database.
7. Run two concurrent authenticated sessions and verify no cross-user reads or writes.
8. Confirm the API and worker report the same database identity (safe metadata only, never credentials).
9. Take a backup/export using the direct URL, restore into a separate Neon branch/database, and repeat the read checks.

## Backup and recovery

- Configure Neon branch/history retention appropriate to the recovery objective and confirm the account's plan supports it.
- Schedule logical exports with `pg_dump` using the direct URL and store encrypted backups outside the database project.
- Define retention, restore ownership, and a recovery runbook. A backup is not verified until a restore has been performed.
- Record recovery point objective (RPO) and recovery time objective (RTO), then run a restore drill before production sign-off.

## Current deployment status

- Neon project/database: **Provisioned in `ap-southeast-1`; operator-provided live Neon E2E output previously verified user/session/conversation persistence. Re-run after the current migration changes.**
- Production connection strings: **Lightsail API/worker service configuration and production-mode startup still require independent verification; do not infer production cutover from a local `.env` or Neon connectivity test.**
- PostgreSQL schema initializer: **Completed — numbered versioned migrations (`server/src/db/migrations/001_initial_schema.sql` and `server/src/db/migrator.js`)**.
- Repository-agent PostgreSQL persistence: **Implemented — uses shared pool and task leasing**.
- Primary application records (auth/users/sessions/conversations): **PostgreSQL repository layer implemented with async boundaries and fail-closed production mode (`server/src/db/database.js`)**.
- Migration & reconciliation tooling: **Expanded to all source tables with atomic import and exact per-table row-count checks; full row-content checksums and live migration execution remain pending (`scripts/migrate-sqlite-to-postgres.mjs`).**
- Migration target safety: **Run against a fresh/empty target branch. Exact total-table row-count reconciliation intentionally fails if target tables already contain unrelated rows; it never truncates production data to force a match.**
- API/worker restart and worker lease-recovery drills: **Pending on the production Lightsail services.**
- Backup/restore: **Pending; no successful restore drill is claimed.**
- Full production cutover: **Not signed off; requires the remaining acceptance checks and verified Lightsail service configuration.**
