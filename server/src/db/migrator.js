/**
 * Neon PostgreSQL Migration Runner for ATH IDE
 *
 * Runs numbered idempotent migrations using the direct (unpooled) PostgreSQL URL,
 * recording version history in schema_migrations.
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "migrations");

/**
 * Configure SSL for PostgreSQL / Neon / Supabase connection.
 */
function getSslConfig(connectionString) {
  if (
    connectionString.includes("sslmode=require") ||
    connectionString.includes("neon.tech") ||
    connectionString.includes("supabase.co") ||
    connectionString.includes("ssl=true")
  ) {
    return { rejectUnauthorized: false };
  }
  return false;
}

/**
 * Read and sort all migration files in migrations directory.
 * @returns {Promise<Array<{ version: number, name: string, fullPath: string }>>}
 */
export async function loadMigrationFiles() {
  const entries = await fs.readdir(MIGRATIONS_DIR, { withFileTypes: true });
  const migrations = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) continue;
    const match = entry.name.match(/^(\d+)_(.+)\.sql$/);
    if (!match) continue;

    migrations.push({
      version: parseInt(match[1], 10),
      name: entry.name,
      fullPath: path.join(MIGRATIONS_DIR, entry.name),
    });
  }

  migrations.sort((a, b) => a.version - b.version);
  return migrations;
}

/**
 * Ensure schema_migrations table exists on the target database.
 * @param {pg.Client} client
 */
export async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/**
 * Fetch list of already-applied migration versions.
 * @param {pg.Client} client
 * @returns {Promise<Set<number>>}
 */
export async function getAppliedVersions(client) {
  await ensureMigrationTable(client);
  const result = await client.query("SELECT version FROM schema_migrations ORDER BY version ASC;");
  return new Set(result.rows.map(row => Number(row.version)));
}

/**
 * Run all pending migrations.
 *
 * @param {object} [options]
 * @param {string} [options.connectionString] - Direct database URL override
 * @param {boolean} [options.dryRun=false] - Only report pending migrations without applying
 * @returns {Promise<{ applied: Array<{ version: number, name: string }>, currentVersion: number }>}
 */
export async function runMigrations({ connectionString, dryRun = false } = {}) {
  const connStr = connectionString || config.directDatabaseUrl || process.env.DATABASE_URL_UNPOOLED || config.databaseUrl;
  if (!connStr) {
    throw new Error("Cannot run migrations: Neither DIRECT_DATABASE_URL nor DATABASE_URL is configured.");
  }

  const client = new Client({
    connectionString: connStr,
    ssl: getSslConfig(connStr),
    statement_timeout: 60000,
  });

  await client.connect();

  try {
    const appliedVersions = await getAppliedVersions(client);
    const availableMigrations = await loadMigrationFiles();
    const pending = availableMigrations.filter(m => !appliedVersions.has(m.version));

    logger.info("Database migration check", {
      totalMigrations: availableMigrations.length,
      alreadyApplied: appliedVersions.size,
      pendingCount: pending.length,
      dryRun,
    });

    if (dryRun) {
      return {
        applied: [],
        pending: pending.map(p => ({ version: p.version, name: p.name })),
        currentVersion: Math.max(0, ...Array.from(appliedVersions)),
      };
    }

    const applied = [];

    for (const migration of pending) {
      logger.info(`Applying migration ${migration.version}: ${migration.name}...`);
      const sql = await fs.readFile(migration.fullPath, "utf8");

      await client.query("BEGIN;");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, CURRENT_TIMESTAMP) ON CONFLICT (version) DO NOTHING;",
          [migration.version, migration.name]
        );
        await client.query("COMMIT;");
        applied.push({ version: migration.version, name: migration.name });
        appliedVersions.add(migration.version);
        logger.info(`Migration ${migration.version} successfully applied.`);
      } catch (err) {
        await client.query("ROLLBACK;");
        logger.error(`Migration ${migration.version} failed: ${err.message}`);
        throw new Error(`Migration ${migration.name} failed: ${err.message}`);
      }
    }

    const currentVersion = Math.max(0, ...Array.from(appliedVersions));
    return { applied, currentVersion };
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Get current migration status.
 */
export async function getMigrationStatus(connectionString) {
  return runMigrations({ connectionString, dryRun: true });
}

// Standalone CLI execution
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const isDryRun = process.argv.includes("--status") || process.argv.includes("--dry-run");
  runMigrations({ dryRun: isDryRun })
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch(err => {
      console.error("Migration error:", err.message);
      process.exit(1);
    });
}

