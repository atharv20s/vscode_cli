# Neon PostgreSQL production rollout

## Status

This document is an operator runbook, not evidence that a Neon project has been provisioned. Do not mark the database deployed until the connection, schema, application persistence, restart, and recovery checks below pass.

## Current database architecture

The current main branch has a PostgreSQL-backed application repository layer:

- `server/src/db/database.js` routes user, authentication, session and conversation operations through the PostgreSQL pool when initialized. SQLite remains a local-development fallback.
- Production startup is fail-closed: the API and repository-agent worker require `DATABASE_URL` and do not silently fall back to per-host SQLite.
- `server/src/db/postgres.js` initializes the pool; `server/src/db/migrator.js` applies numbered, repeatable migrations using the direct URL.
- The API and repository-agent worker must use the same Neon database/branch. The API health response reports a non-secret `database.identity` fingerprint; the repository-agent worker logs the same `databaseIdentity` at startup. The direct and pooled Neon hostnames normalize to the same fingerprint. Compare these values during deployment acceptance. This confirms configured endpoint/database/role identity, not worker recovery, multi-user isolation or backup restoration.
- `scripts/migrate-sqlite-to-postgres.mjs` migrates non-internal SQLite tables transactionally and checks exact per-table row counts. It does not yet calculate row-by-row content checksums.

The operator has reported successful production health and a successful SQLite migration. A prior report showed 7 users/7 sessions while a later inspection showed 2/2; confirm both reports were taken against the same endpoint, database and branch before declaring data reconciliation complete.

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
8. Confirm the API `/api/health` `database.identity` and repository-agent worker startup `databaseIdentity` values match (safe fingerprint only, never credentials).
9. Take a backup/export using the direct URL, restore into a separate Neon branch/database, and repeat the read checks.

## Encrypted logical backup and restore

The repository now includes `scripts/neon-db-backup.mjs` and npm shortcuts:

- `npm run db:backup` streams a PostgreSQL custom-format dump directly through AES-256-GCM encryption. It does not write an unencrypted dump to disk.
- `npm run db:restore -- <archive.athpg>` decrypts and verifies the archive before piping it to `pg_restore`.
- Both operations use libpq environment variables so the database password is not placed in the process argument list. TLS verification is forced to `verify-full`.
- Restore intentionally omits `--clean`; it does not drop or overwrite existing objects. Restore only into a newly created, empty Neon branch/database.

Generate a 32-byte key and store it in a secret manager (do not commit it or paste it into chat):

```bash
openssl rand -hex 32
```

Backup:

```bash
export DIRECT_DATABASE_URL='postgresql://...'
export NEON_BACKUP_KEY='<64-hex-character-key>'
npm run db:backup -- ./backups/neon-production.athpg
```

Restore drill into a separate, empty Neon branch/database:

```bash
export RESTORE_DATABASE_URL='postgresql://...'
export RESTORE_CONFIRM_EMPTY_TARGET=YES
export NEON_BACKUP_KEY='<same-64-hex-character-key>'
npm run db:restore -- ./backups/neon-production.athpg
```

The host must have compatible `pg_dump` and `pg_restore` binaries installed. Store encrypted archives outside the Neon project, restrict access, define retention, and record the restore result, RPO and RTO. **Adding the utility is not evidence that a production backup or restore drill has run.**

## Current deployment status

- Neon project/database: **Provisioned in `ap-southeast-1`; operator-provided API health output reported PostgreSQL connected. This was not independently queried from this repository session.**
- Production API/worker environment: **Operator reported updating Lightsail service environment files and restarting both services. Exact API/worker database identity and post-restart task recovery still need an acceptance run.**
- PostgreSQL schema: **Implemented — numbered migrations and schema version ledger.**
- Primary application records: **PostgreSQL repository adapter implemented; production signup/login/session/conversation acceptance tests still need a fresh disposable-Postgres run.**
- SQLite migration: **Implemented — transactional all-table import and exact row-count reconciliation. Content checksums and resolution of the reported 7-versus-2 count difference remain outstanding.**
- Multi-user isolation: **Owner-scoped workspace paths and container identities are implemented; CI isolation regression test is being added. Production concurrent-user test remains outstanding.**
- Workspace object storage: **S3-compatible snapshots are implemented in the execution worker. Snapshot validation and SHA-256 integrity checks are now included. A real production restore drill remains required.**
- Terminal recovery: **tmux-backed terminal sessions are implemented inside persistent workspace containers. Recovery after an execution-worker process restart depends on the Docker container remaining alive; container/VM restart recovery of arbitrary running processes is not guaranteed.**
- Backup/restore: **Encrypted AES-256-GCM backup/restore utility is now included. No production backup or restore has yet been claimed.**
- Production sign-off: **Pending real acceptance runs, verified recovery, and confirmation of consistent API/worker configuration.**


## Read-only migration count reconciliation

To investigate the previously reported 7-user/7-session versus 2-user/2-session
counts, run this on a trusted operator host with the same production database
environment used by the API:

```bash
npm run db:audit-migration-counts
```

This reports the current Neon endpoint/database/role fingerprint, schema
version, user/session counts, orphan-session count, and a hash of the ID sets.
If the original SQLite source file is still available, set
`SQLITE_SOURCE_PATH=/absolute/path/to/source.sqlite` before running. The script
opens SQLite read-only and compares exact user/session ID sets without printing
raw IDs. It exits non-zero if the source and Neon sets differ or if Neon has
orphan sessions. It does not migrate, repair, or delete any rows.

Compare the printed `databaseIdentity` with the API health response and the
repo-agent worker's `databaseIdentity` startup log. Pooled and direct Neon
URLs should produce the same identity when they point to the same branch,
database and role. The audit cannot establish whether historical reports came
from the same branch unless those original connection identities were recorded.
