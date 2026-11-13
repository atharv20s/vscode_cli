/**
 * PostgreSQL Database Layer (Neon / Supabase / AWS RDS / Google Cloud SQL)
 *
 * Provides connection pooling, automated versioned migration execution,
 * query execution, and database health metrics.
 */

import pg from "pg";
import crypto from "crypto";
import { logger } from "../config/logger.js";
import { runMigrations } from "./migrator.js";

const { Pool } = pg;

let pool = null;
let poolIdentity = null;

function getSslConfig(connectionString) {
  if (
    connectionString.includes("sslmode=require") ||
    connectionString.includes("neon.tech") ||
    connectionString.includes("supabase.co") ||
    connectionString.includes("ssl=true")
  ) {
    return { rejectUnauthorized: true };
  }
  return false;
}

/**
 * Initialize PostgreSQL connection pool and execute schema migrations.
 * @param {string} connectionString - e.g. postgresql://user:password@host/db?sslmode=require
 * @param {object} [options]
 * @param {string} [options.directUrl] - Direct connection URL for migrations
 * @returns {Promise<pg.Pool>}
 */
export async function initPostgres(connectionString, options = {}) {
  if (pool) return pool;

  if (!connectionString) {
    throw new Error("Cannot initialize PostgreSQL: connectionString is missing.");
  }

  // 1. Run migrations first using direct URL or main connection string
  const migrationUrl = options.directUrl || process.env.DIRECT_DATABASE_URL || connectionString;
  try {
    await runMigrations({ connectionString: migrationUrl });
    logger.info("PostgreSQL schema migrations verified/applied successfully");
  } catch (migErr) {
    logger.error("Failed to apply PostgreSQL schema migrations", { error: migErr.message });
    throw migErr;
  }

  // 2. Initialize pooled client for application queries
  pool = new Pool({
    connectionString,
    ssl: getSslConfig(connectionString),
    max: parseInt(process.env.PG_POOL_MAX || "10", 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 20000,
  });

  // Test pool connection
  const client = await pool.connect();
  try {
    const res = await client.query("SELECT CURRENT_TIMESTAMP AS now, current_database() AS database_name, current_user AS database_role;");
    let normalizedHost = "";
    try {
      normalizedHost = new URL(connectionString).hostname.toLowerCase().replace(/-pooler(?=\\.)/, "");
    } catch {}
    const identityMaterial = [normalizedHost, res.rows[0]?.database_name || "", res.rows[0]?.database_role || ""].join("/");
    poolIdentity = crypto.createHash("sha256").update(identityMaterial).digest("hex").slice(0, 24);
    logger.info("Connected to PostgreSQL Database Pool (Neon/AWS RDS)", {
      timestamp: res.rows[0]?.now,
      databaseIdentity: poolIdentity,
    });
  } finally {
    client.release();
  }

  return pool;
}

/**
 * Get the PostgreSQL pool instance.
 * @returns {pg.Pool | null}
 */
export function getPostgresPool() {
  return pool;
}

/**
 * Non-secret fingerprint for comparing API and worker database configuration.
 * Pooled and direct Neon hostnames normalize to the same endpoint identity.
 */
export function getPostgresIdentity() {
  return poolIdentity;
}

/**
 * Set the PostgreSQL pool instance (used for testing or dependency injection).
 * @param {pg.Pool | null} customPool
 */
export function setPostgresPool(customPool) {
  pool = customPool;
  poolIdentity = null;
}

/**
 * Close PostgreSQL connection pool gracefully.
 */
export async function closePostgres() {
  if (pool) {
    const p = pool;
    pool = null;
    poolIdentity = null;
    await p.end().catch(() => {});
  }
}

/**
 * Check PostgreSQL health, latency, and schema version.
 * @returns {Promise<{ ok: boolean, dialect: string, latencyMs?: number, schemaVersion?: number, poolStats?: object, error?: string }>}
 */
export async function getPostgresHealth() {
  if (!pool) {
    return { ok: false, dialect: "postgres", error: "PostgreSQL pool is not initialized" };
  }

  const start = Date.now();
  try {
    const client = await pool.connect();
    try {
      const verRes = await client.query("SELECT COALESCE(MAX(version), 0) AS max_ver FROM schema_migrations;");
      const latencyMs = Date.now() - start;
      return {
        ok: true,
        connected: true,
        dialect: "postgres",
        latencyMs,
        schemaVersion: Number(verRes.rows[0]?.max_ver || 0),
        databaseIdentity: poolIdentity,
        poolStats: {
          totalCount: pool.totalCount,
          idleCount: pool.idleCount,
          waitingCount: pool.waitingCount,
        },
      };
    } finally {
      client.release();
    }
  } catch (err) {
    return {
      ok: false,
      dialect: "postgres",
      latencyMs: Date.now() - start,
      error: err.message,
    };
  }
}

/**
 * Migrates temporary guest records to authenticated user upon signup / login.
 */
export async function migrateGuestRecords(guestUserId, permanentUserId) {
  if (!pool || !guestUserId || !permanentUserId || guestUserId === permanentUserId) return;
  try {
    await pool.query(
      `UPDATE sessions SET user_id = $1 WHERE user_id = $2`,
      [permanentUserId, guestUserId]
    );
    logger.info(`Migrated guest data from ${guestUserId} -> ${permanentUserId}`);
  } catch (err) {
    logger.warn(`Guest migration warning: ${err.message}`);
  }
}

/**
 * Persists terminal execution entry to database.
 */
export async function recordTerminalExecution({ sessionId, command, output, exitCode, shell }) {
  if (!pool || !sessionId || !command) return;
  try {
    await pool.query(
      `INSERT INTO terminal_history (session_id, command, output, exit_code, shell)
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, command, output ? output.slice(0, 10000) : null, exitCode ?? 0, shell || "powershell"]
    );
  } catch (err) {
    logger.debug(`recordTerminalExecution: ${err.message}`);
  }
}

/**
 * Persists GitHub commit trace to database.
 */
export async function recordGithubCommit({ userId, repoName, commitSha, commitMessage, branch, action }) {
  if (!pool || !userId || !repoName) return;
  try {
    await pool.query(
      `INSERT INTO github_history (user_id, repo_name, commit_sha, commit_message, branch, action)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, repoName, commitSha || null, commitMessage || "Auto-commit", branch || "main", action || "commit"]
    );
  } catch (err) {
    logger.debug(`recordGithubCommit: ${err.message}`);
  }
}
