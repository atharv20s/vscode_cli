#!/usr/bin/env node
/**
 * SQLite to Neon PostgreSQL Data Migration Tool for ATH IDE
 *
 * Migrates users, sessions, conversations, tasks, rounds, shares, usage records,
 * and cache entries from SQLite to PostgreSQL with full foreign-key ordering,
 * idempotency, and reconciliation checks.
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
let Database = null;
try {
  const mod = await import("better-sqlite3");
  Database = mod.default || mod;
} catch {
  // better-sqlite3 native bindings may not be present on Windows without C++ compiler
}
import pg from "pg";
import dotenv from "dotenv";
import { runMigrations } from "../server/src/db/migrator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, "../server/.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const { Client } = pg;

const DEFAULT_SQLITE_PATH = path.resolve(__dirname, "../server/data/agentic.db");

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

function safeJson(val, fallback = null) {
  if (!val) return fallback;
  if (typeof val === "object") return val;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
}

export async function migrateSqliteToPostgres({
  sqlitePath = DEFAULT_SQLITE_PATH,
  postgresUrl = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL,
  dryRun = false,
} = {}) {
  console.log("=================================================================");
  console.log("ATH IDE SQLite -> Neon PostgreSQL Data Migration");
  console.log("=================================================================");
  console.log("SQLite Path:", sqlitePath);
  console.log("PostgreSQL Target:", postgresUrl ? postgresUrl.replace(/:[^:@]+@/, ":****@") : "(none)");
  console.log("Dry Run:", dryRun);
  console.log("Timestamp:", new Date().toISOString());

  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`SQLite source database not found at path: ${sqlitePath}. Refusing to report a skipped migration as successful.`);
  }

  if (!Database) {
    throw new Error("better-sqlite3 native bindings are unavailable. Run the migration in the source database environment; no migration was performed.");
  }

  if (!postgresUrl) {
    throw new Error("Target PostgreSQL connection string is missing. Set DIRECT_DATABASE_URL or DATABASE_URL.");
  }

  // 1. Ensure target schema migrations are up to date
  console.log("\n[Step 1] Ensuring PostgreSQL schema migrations are current...");
  await runMigrations({ connectionString: postgresUrl });

  // 2. Open SQLite database in read-only mode
  console.log("\n[Step 2] Connecting to SQLite source (read-only)...");
  const sqlite = new Database(sqlitePath, { readonly: true });

  // 3. Connect to PostgreSQL
  console.log("[Step 3] Connecting to PostgreSQL target...");
  const pgClient = new Client({
    connectionString: postgresUrl,
    ssl: getSslConfig(postgresUrl),
  });
  await pgClient.connect();

  const report = {};

  try {
    // 4. Migrate Users
    console.log("\n[Step 4] Migrating 'users' table...");
    const users = sqlite.prepare("SELECT * FROM users").all();
    report.users = { sqliteCount: users.length, migrated: 0 };
    for (const u of users) {
      if (!dryRun) {
        await pgClient.query(
          `INSERT INTO users (id, github_id, username, email, password_hash, avatar_url, github_access_token, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, CURRENT_TIMESTAMP), COALESCE($9::timestamptz, CURRENT_TIMESTAMP))
           ON CONFLICT (id) DO UPDATE SET
             github_id = COALESCE(EXCLUDED.github_id, users.github_id),
             username = EXCLUDED.username,
             email = COALESCE(EXCLUDED.email, users.email),
             password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash),
             avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
             github_access_token = COALESCE(EXCLUDED.github_access_token, users.github_access_token),
             updated_at = EXCLUDED.updated_at;`,
          [
            u.id,
            u.github_id || null,
            u.username,
            u.email || null,
            u.password_hash || null,
            u.avatar_url || null,
            u.github_access_token || null,
            u.created_at || null,
            u.updated_at || null,
          ]
        );
      }
      report.users.migrated++;
    }

    // 5. Migrate Sessions
    console.log("[Step 5] Migrating 'sessions' table...");
    const sessions = sqlite.prepare("SELECT * FROM sessions").all();
    report.sessions = { sqliteCount: sessions.length, migrated: 0 };
    for (const s of sessions) {
      if (!dryRun) {
        await pgClient.query(
          `INSERT INTO sessions (id, user_id, workspace_path, created_at, last_active)
           VALUES ($1, $2, $3, COALESCE($4::timestamptz, CURRENT_TIMESTAMP), COALESCE($5::timestamptz, CURRENT_TIMESTAMP))
           ON CONFLICT (id) DO UPDATE SET
             workspace_path = EXCLUDED.workspace_path,
             last_active = EXCLUDED.last_active;`,
          [s.id, s.user_id, s.workspace_path || null, s.created_at || null, s.last_active || null]
        );
      }
      report.sessions.migrated++;
    }

    // 6. Migrate Conversations
    console.log("[Step 6] Migrating 'conversations' table...");
    const conversations = sqlite.prepare("SELECT * FROM conversations").all();
    report.conversations = { sqliteCount: conversations.length, migrated: 0 };
    for (const c of conversations) {
      const messagesJson = JSON.stringify(safeJson(c.messages, []));
      if (!dryRun) {
        await pgClient.query(
          `INSERT INTO conversations (id, session_id, user_id, title, messages, model, total_tokens, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, COALESCE($8::timestamptz, CURRENT_TIMESTAMP), COALESCE($9::timestamptz, CURRENT_TIMESTAMP))
           ON CONFLICT (id) DO UPDATE SET
             title = EXCLUDED.title,
             messages = EXCLUDED.messages,
             model = EXCLUDED.model,
             total_tokens = EXCLUDED.total_tokens,
             updated_at = EXCLUDED.updated_at;`,
          [
            c.id,
            c.session_id,
            c.user_id || null,
            c.title || null,
            messagesJson,
            c.model || null,
            c.total_tokens || 0,
            c.created_at || null,
            c.updated_at || null,
          ]
        );
      }
      report.conversations.migrated++;
    }

    // 7. Migrate Repo Agent Tasks
    console.log("[Step 7] Migrating 'repo_agent_tasks' table...");
    let tasks = [];
    try {
      tasks = sqlite.prepare("SELECT * FROM repo_agent_tasks").all();
    } catch {}
    report.repo_agent_tasks = { sqliteCount: tasks.length, migrated: 0 };
    for (const t of tasks) {
      const eventsJson = JSON.stringify(safeJson(t.events_json, []));
      if (!dryRun) {
        await pgClient.query(
          `INSERT INTO repo_agent_tasks (
             id, user_id, owner, repo, base_branch, base_sha, branch, prompt,
             workspace_path, status, events_json, pr_url, pr_number, error,
             attempt_count, worker_id, lease_expires_at, cancel_requested,
             github_token_ciphertext, github_token_iv, github_token_tag, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14,
             $15, $16, $17::timestamptz, $18, $19, $20, $21, COALESCE($22::timestamptz, CURRENT_TIMESTAMP), COALESCE($23::timestamptz, CURRENT_TIMESTAMP)
           )
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status,
             events_json = EXCLUDED.events_json,
             pr_url = EXCLUDED.pr_url,
             pr_number = EXCLUDED.pr_number,
             error = EXCLUDED.error,
             attempt_count = EXCLUDED.attempt_count,
             worker_id = EXCLUDED.worker_id,
             lease_expires_at = EXCLUDED.lease_expires_at,
             cancel_requested = EXCLUDED.cancel_requested,
             updated_at = EXCLUDED.updated_at;`,
          [
            t.id,
            t.user_id,
            t.owner,
            t.repo,
            t.base_branch,
            t.base_sha,
            t.branch,
            t.prompt,
            t.workspace_path || "",
            t.status || "queued",
            eventsJson,
            t.pr_url || null,
            t.pr_number || null,
            t.error || null,
            t.attempt_count || 0,
            t.worker_id || null,
            t.lease_expires_at || null,
            Boolean(t.cancel_requested),
            t.github_token_ciphertext || null,
            t.github_token_iv || null,
            t.github_token_tag || null,
            t.created_at || null,
            t.updated_at || null,
          ]
        );
      }
      report.repo_agent_tasks.migrated++;
    }

    // 8. Migrate Repo Agent Context Rounds
    console.log("[Step 8] Migrating 'repo_agent_context_rounds' table...");
    let rounds = [];
    try {
      rounds = sqlite.prepare("SELECT * FROM repo_agent_context_rounds").all();
    } catch {}
    report.repo_agent_context_rounds = { sqliteCount: rounds.length, migrated: 0 };
    for (const r of rounds) {
      const evidenceJson = JSON.stringify(safeJson(r.evidence_json || r.evidence, {}));
      if (!dryRun) {
        await pgClient.query(
          `INSERT INTO repo_agent_context_rounds (task_id, round_number, agent_role, status, input_summary, output_summary, evidence, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, COALESCE($8::timestamptz, CURRENT_TIMESTAMP))
           ON CONFLICT (task_id, round_number, agent_role) DO UPDATE SET
             status = EXCLUDED.status,
             input_summary = EXCLUDED.input_summary,
             output_summary = EXCLUDED.output_summary,
             evidence = EXCLUDED.evidence;`,
          [
            r.task_id,
            r.round_number,
            r.agent_role,
            r.status,
            r.input_summary || null,
            r.output_summary || null,
            evidenceJson,
            r.created_at || null,
          ]
        );
      }
      report.repo_agent_context_rounds.migrated++;
    }

    // 9. Migrate Repo Agent Shares
    console.log("[Step 9] Migrating 'repo_agent_shares' table...");
    let shares = [];
    try {
      shares = sqlite.prepare("SELECT * FROM repo_agent_shares").all();
    } catch {}
    report.repo_agent_shares = { sqliteCount: shares.length, migrated: 0 };
    for (const sh of shares) {
      if (!dryRun) {
        await pgClient.query(
          `INSERT INTO repo_agent_shares (id, task_id, owner_user_id, token_hash, permission, expires_at, revoked_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, COALESCE($8::timestamptz, CURRENT_TIMESTAMP))
           ON CONFLICT (id) DO UPDATE SET
             permission = EXCLUDED.permission,
             expires_at = EXCLUDED.expires_at,
             revoked_at = EXCLUDED.revoked_at;`,
          [
            sh.id,
            sh.task_id,
            sh.owner_user_id,
            sh.token_hash,
            sh.permission,
            sh.expires_at || null,
            sh.revoked_at || null,
            sh.created_at || null,
          ]
        );
      }
      report.repo_agent_shares.migrated++;
    }

    // 10. Migrate LLM Daily Usage & Reservations
    console.log("[Step 10] Migrating 'llm_daily_usage' table...");
    let usage = [];
    try {
      usage = sqlite.prepare("SELECT * FROM llm_daily_usage").all();
    } catch {}
    report.llm_daily_usage = { sqliteCount: usage.length, migrated: 0 };
    for (const u of usage) {
      if (!dryRun) {
        await pgClient.query(
          `INSERT INTO llm_daily_usage (user_id, usage_date, spent_usd, reserved_usd, input_tokens, output_tokens, request_count, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, CURRENT_TIMESTAMP))
           ON CONFLICT (user_id, usage_date) DO UPDATE SET
             spent_usd = EXCLUDED.spent_usd,
             reserved_usd = EXCLUDED.reserved_usd,
             input_tokens = EXCLUDED.input_tokens,
             output_tokens = EXCLUDED.output_tokens,
             request_count = EXCLUDED.request_count,
             updated_at = EXCLUDED.updated_at;`,
          [
            u.user_id,
            u.usage_date,
            u.spent_usd || 0,
            u.reserved_usd || 0,
            u.input_tokens || 0,
            u.output_tokens || 0,
            u.request_count || 0,
            u.updated_at || null,
          ]
        );
      }
      report.llm_daily_usage.migrated++;
    }

    // 11. Migrate every remaining application table present in the SQLite source.
    // The explicit migrations above handle tables whose schemas need custom transforms.
    // This covers the remaining schema-compatible tables and fails closed for unknown tables.
    const explicitlyMigrated = new Set(Object.keys(report));
    const sqliteTables = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map(row => row.name);

    for (const table of sqliteTables) {
      if (explicitlyMigrated.has(table)) continue;
      if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
        throw new Error(`Unsafe or unsupported SQLite table name: ${table}`);
      }

      const targetColumnsResult = await pgClient.query(
        "SELECT column_name, data_type, udt_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
        [table]
      );
      if (!targetColumnsResult.rows.length) {
        throw new Error(`SQLite table '${table}' has no matching PostgreSQL table; refusing to skip source data.`);
      }

      const sourceColumns = sqlite.prepare(`PRAGMA table_info("${table}")`).all().map(column => column.name);
      const targetColumns = new Map(targetColumnsResult.rows.map(column => [column.column_name, column]));
      const aliases = { evidence_json: "evidence" };
      const mapping = sourceColumns
        .map(source => ({ source, target: aliases[source] || source }))
        .filter(item => targetColumns.has(item.target));
      if (!mapping.length) {
        throw new Error(`No compatible columns found for SQLite table '${table}'.`);
      }

      const sourceRows = sqlite.prepare(`SELECT * FROM "${table}"`).all();
      const targetNames = mapping.map(item => item.target);
      const placeholders = mapping.map((item, index) => {
        const type = targetColumns.get(item.target).udt_name;
        return type === "jsonb" || type === "json" ? `${index + 1}::${type}` : `${index + 1}`;
      });
      const insertSql = `INSERT INTO "${table}" (${targetNames.map(name => `"${name}"`).join(", ")}) VALUES (${placeholders.join(", ")}) ON CONFLICT DO NOTHING`;

      report[table] = { sqliteCount: sourceRows.length, migrated: 0 };
      for (const row of sourceRows) {
        const values = mapping.map(item => {
          const value = row[item.source];
          const targetType = targetColumns.get(item.target).udt_name;
          if (value == null) return null;
          if ((targetType === "jsonb" || targetType === "json") && typeof value === "string") {
            try { return JSON.stringify(JSON.parse(value)); }
            catch { throw new Error(`Invalid JSON in ${table}.${item.source}; refusing lossy migration.`); }
          }
          return value;
        });
        if (!dryRun) await pgClient.query(insertSql, values);
        report[table].migrated++;
      }
    }

    // 12. Reconcile each migrated table with exact row counts.
    console.log("\n[Step 12] Running exact per-table reconciliation queries on PostgreSQL...");

    for (const [table, stats] of Object.entries(report)) {
      if (!dryRun) {
        const countRes = await pgClient.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
        stats.postgresCount = countRes.rows[0]?.count || 0;
        stats.verified = stats.postgresCount === stats.sqliteCount;
      } else {
        stats.postgresCount = "dry-run";
        stats.verified = null;
      }
    }

    console.log("\n=================================================================");
    console.log("MIGRATION RECONCILIATION SUMMARY");
    console.log("=================================================================");
    console.table(report);

    const allVerified = !dryRun && Object.values(report).every(r => r.verified === true);
    if (dryRun) {
      console.log("Dry run complete: no rows were migrated and no reconciliation was performed.");
      return { success: false, dryRun: true, report };
    }
    if (!allVerified) {
      throw new Error("Exact reconciliation failed: SQLite and PostgreSQL row counts differ for one or more tables.");
    }

    console.log("All tables reconciled and verified successfully!");
    return { success: true, report };
  } finally {
    sqlite.close();
    await pgClient.end().catch(() => {});
  }
}

// Standalone CLI execution
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const isDryRun = process.argv.includes("--dry-run");
  migrateSqliteToPostgres({ dryRun: isDryRun })
    .then(() => {
      console.log("Migration script completed.");
      process.exit(0);
    })
    .catch(err => {
      console.error("Migration error:", err);
      process.exit(1);
    });
}

