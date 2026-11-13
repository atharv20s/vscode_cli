#!/usr/bin/env node
/**
 * Read-only audit for the historical 7-vs-2 SQLite/Neon migration discrepancy.
 *
 * Required: DIRECT_DATABASE_URL (or DATABASE_URL).
 * Optional: DATABASE_URL for the pooled app connection and SQLITE_SOURCE_PATH
 * for a read-only copy of the original SQLite database.
 *
 * No database rows are changed. Raw user/session IDs and credentials are never
 * printed; when SQLite is supplied, only count and set-reconciliation results
 * are emitted.
 */
import crypto from "node:crypto";
import path from "node:path";
import dotenv from "dotenv";
import pg from "pg";
import Database from "better-sqlite3";
import { createPostgresIdentity } from "../src/db/postgres.js";
import { config } from "../src/config/env.js";

dotenv.config();
const { Client } = pg;
const directUrl = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL_UNPOOLED || config.directDatabaseUrl || process.env.DATABASE_URL || config.databaseUrl || "";
const pooledUrl = process.env.DATABASE_URL || config.databaseUrl || directUrl;
if (!directUrl) throw new Error("DIRECT_DATABASE_URL or DATABASE_URL is required.");

function sslFor(connectionString) {
  const host = new URL(connectionString).hostname;
  return host.endsWith(".neon.tech") || host.endsWith(".supabase.co")
    ? { rejectUnauthorized: true }
    : undefined;
}

function connect(connectionString) {
  return new Client({ connectionString, ssl: sslFor(connectionString), connectionTimeoutMillis: 15000 });
}

function idSetHash(values) {
  return crypto.createHash("sha256").update([...values].sort().join("\n")).digest("hex");
}

async function inspectPostgres(connectionString) {
  const client = connect(connectionString);
  await client.connect();
  try {
    const identityResult = await client.query(
      "SELECT current_database() AS database_name, current_user AS database_role, inet_server_addr()::text AS server_address"
    );
    const identityRow = identityResult.rows[0];
    const identity = createPostgresIdentity(connectionString, identityRow.database_name, identityRow.database_role);
    const counts = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM users) AS users,
        (SELECT COUNT(*)::int FROM sessions) AS sessions,
        (SELECT COUNT(*)::int FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE u.id IS NULL) AS orphan_sessions,
        (SELECT COALESCE(MAX(version), 0)::int FROM schema_migrations) AS schema_version
    `);
    const userIds = (await client.query("SELECT id FROM users")).rows.map(row => String(row.id));
    const sessionIds = (await client.query("SELECT id FROM sessions")).rows.map(row => String(row.id));
    return {
      identity,
      host: new URL(connectionString).hostname,
      database: identityRow.database_name,
      role: identityRow.database_role,
      serverAddress: identityRow.server_address,
      counts: counts.rows[0],
      userIds,
      sessionIds,
    };
  } finally {
    await client.end();
  }
}

function inspectSqlite(filePath) {
  const absolute = path.resolve(filePath);
  const db = new Database(absolute, { readonly: true, fileMustExist: true });
  try {
    const userIds = db.prepare("SELECT id FROM users").all().map(row => String(row.id));
    const sessionIds = db.prepare("SELECT id FROM sessions").all().map(row => String(row.id));
    const orphanSessions = db.prepare(
      "SELECT COUNT(*) AS count FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE u.id IS NULL"
    ).get().count;
    return {
      source: path.basename(absolute),
      counts: { users: userIds.length, sessions: sessionIds.length, orphan_sessions: orphanSessions },
      userIds,
      sessionIds,
    };
  } finally {
    db.close();
  }
}

const [direct, pooled] = await Promise.all([
  inspectPostgres(directUrl),
  pooledUrl === directUrl ? Promise.resolve(null) : inspectPostgres(pooledUrl),
]);
const apiHealthUrl = process.env.API_HEALTH_URL || (config.publicUrl ? new URL("/api/health", config.publicUrl).toString() : "");
let apiIdentity = null;
if (apiHealthUrl) {
  const response = await fetch(apiHealthUrl, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("API health endpoint returned HTTP " + response.status);
  const health = await response.json();
  apiIdentity = health.database?.identity || null;
}
const workerIdentity = process.env.REPO_AGENT_WORKER_DATABASE_IDENTITY || null;
const pooledIdentityMatches = !pooled || direct.identity === pooled.identity;
const apiIdentityMatches = !apiIdentity || apiIdentity === direct.identity;
const workerIdentityMatches = !workerIdentity || workerIdentity === direct.identity;
const identityMatches = pooledIdentityMatches && apiIdentityMatches && workerIdentityMatches;
const identityVerificationComplete = Boolean(apiIdentity && workerIdentity) &&
  pooledIdentityMatches && apiIdentityMatches && workerIdentityMatches;
const result = {
  audit: "neon-migration-counts-and-identity",
  readOnly: true,
  postgres: {
    host: direct.host,
    database: direct.database,
    role: direct.role,
    databaseIdentity: direct.identity,
    counts: direct.counts,
    userIdSetSha256: idSetHash(direct.userIds),
    sessionIdSetSha256: idSetHash(direct.sessionIds),
  },
  pooledConnection: pooled ? {
    host: pooled.host,
    database: pooled.database,
    role: pooled.role,
    databaseIdentity: pooled.identity,
    identityMatchesDirect: pooled.identity === direct.identity,
  } : { sameConnectionAsDirect: true, identityMatchesDirect: true },
  sqliteSource: null,
  reconciliation: "not performed: set SQLITE_SOURCE_PATH to the original SQLite database file",
  identityMatches,
  identityVerificationComplete,
  identityChecks: {
    pooledMatchesDirect: pooledIdentityMatches,
    apiHealthIdentity: apiIdentity,
    apiMatchesDirect: apiIdentity ? apiIdentityMatches : null,
    repoAgentWorkerIdentity: workerIdentity,
    workerMatchesDirect: workerIdentity ? workerIdentityMatches : null,
  },
};

if (process.env.SQLITE_SOURCE_PATH) {
  const sqlite = inspectSqlite(process.env.SQLITE_SOURCE_PATH);
  const missingUsers = sqlite.userIds.filter(id => !direct.userIds.includes(id));
  const extraUsers = direct.userIds.filter(id => !sqlite.userIds.includes(id));
  const missingSessions = sqlite.sessionIds.filter(id => !direct.sessionIds.includes(id));
  const extraSessions = direct.sessionIds.filter(id => !sqlite.sessionIds.includes(id));
  const exactMatch = missingUsers.length === 0 && extraUsers.length === 0 &&
    missingSessions.length === 0 && extraSessions.length === 0;
  result.sqliteSource = {
    source: sqlite.source,
    counts: sqlite.counts,
    userIdSetSha256: idSetHash(sqlite.userIds),
    sessionIdSetSha256: idSetHash(sqlite.sessionIds),
  };
  result.reconciliation = {
    exactIdSetMatch: exactMatch,
    missingUsersInNeon: missingUsers.length,
    extraUsersInNeon: extraUsers.length,
    missingSessionsInNeon: missingSessions.length,
    extraSessionsInNeon: extraSessions.length,
    orphanSessionsInNeon: Number(direct.counts.orphan_sessions),
  };
  if (!exactMatch || Number(direct.counts.orphan_sessions) !== 0) process.exitCode = 2;
}

console.log(JSON.stringify(result, null, 2));
if (!identityMatches || !identityVerificationComplete) process.exitCode = 3;
if (!process.env.SQLITE_SOURCE_PATH && !process.exitCode) process.exitCode = 4;
