#!/usr/bin/env node
/**
 * Full encrypted Neon backup/restore acceptance drill.
 *
 * Source: DIRECT_DATABASE_URL
 * Target: RESTORE_DATABASE_URL (must be a different, empty Neon branch/database)
 * Key:    NEON_BACKUP_KEY (64 hex characters)
 *
 * Creates an encrypted backup, restores it into the empty target, then compares
 * exact user-table names and row counts. Run during a write-quiescent window so
 * source counts do not change while pg_dump captures its consistent snapshot.
 */
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";
import { createPostgresIdentity } from "../src/db/postgres.js";

dotenv.config();
const { Client } = pg;
const sourceUrl = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL_UNPOOLED || "";
const targetUrl = process.env.RESTORE_DATABASE_URL || "";
const key = process.env.NEON_BACKUP_KEY || "";
if (!sourceUrl || !targetUrl) throw new Error("DIRECT_DATABASE_URL and RESTORE_DATABASE_URL are required.");
if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error("NEON_BACKUP_KEY must be a 64-character hexadecimal AES-256 key.");
if (process.env.RESTORE_CONFIRM_EMPTY_TARGET !== "YES") {
  throw new Error("Set RESTORE_CONFIRM_EMPTY_TARGET=YES only after confirming the target is a separate disposable Neon branch/database.");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backupScript = path.resolve(__dirname, "../../scripts/neon-db-backup.mjs");
const backupPath = path.resolve(process.env.NEON_BACKUP_OUTPUT ||
  path.join("backups", "neon-restore-drill-" + new Date().toISOString().replace(/[:.]/g, "-") + ".athpg"));

function sslFor(connectionString) {
  const host = new URL(connectionString).hostname;
  return host.endsWith(".neon.tech") || host.endsWith(".supabase.co")
    ? { rejectUnauthorized: true }
    : undefined;
}

async function withClient(connectionString, task) {
  const client = new Client({ connectionString, ssl: sslFor(connectionString), connectionTimeoutMillis: 15000 });
  await client.connect();
  try { return await task(client); }
  finally { await client.end(); }
}

async function inspectIdentity(client, url) {
  const result = await client.query(
    "SELECT current_database() AS database_name, current_user AS database_role"
  );
  const row = result.rows[0];
  const host = new URL(url).hostname.toLowerCase();
  const normalizedHost = host.replace(/-pooler(?=\\.)/, "");
  return {
    host,
    normalizedHost,
    database: row.database_name,
    role: row.database_role,
    fingerprint: createPostgresIdentity(url, row.database_name, row.database_role),
  };
}

async function inspectTableCounts(client) {
  const tables = await client.query(`
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY schemaname, tablename
  `);
  const counts = {};
  for (const row of tables.rows) {
    const schema = '"' + row.schemaname.replace(/"/g, '""') + '"';
    const table = '"' + row.tablename.replace(/"/g, '""') + '"';
    const count = await client.query("SELECT COUNT(*)::bigint AS count FROM " + schema + "." + table);
    counts[row.schemaname + "." + row.tablename] = Number(count.rows[0].count);
  }
  return counts;
}

function runBackup(operation, filePath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [backupScript, operation, filePath], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(operation + " failed (exit " + code + "): " + stderr.trim()));
    });
  });
}

const sourceIdentity = await withClient(sourceUrl, client => inspectIdentity(client, sourceUrl));
const targetIdentity = await withClient(targetUrl, client => inspectIdentity(client, targetUrl));
if (sourceIdentity.normalizedHost === targetIdentity.normalizedHost &&
    sourceIdentity.database === targetIdentity.database) {
  throw new Error("Refusing restore: source and target resolve to the same Neon endpoint and database, even if credentials/roles differ.");
}

const targetBefore = await withClient(targetUrl, async client => {
  const result = await client.query(`
    SELECT COUNT(*)::int AS relation_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  `);
  return Number(result.rows[0].relation_count);
});
if (targetBefore !== 0) {
  throw new Error("Refusing restore: target contains " + targetBefore + " user relations. Create a fresh empty Neon branch/database.");
}

const sourceCountsBefore = await withClient(sourceUrl, inspectTableCounts);
await fs.mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
await runBackup("backup", backupPath, {
  ...process.env,
  DIRECT_DATABASE_URL: sourceUrl,
  NEON_BACKUP_KEY: key,
});
const backupStat = await fs.stat(backupPath);

await runBackup("restore", backupPath, {
  ...process.env,
  RESTORE_DATABASE_URL: targetUrl,
  RESTORE_CONFIRM_EMPTY_TARGET: "YES",
  NEON_BACKUP_KEY: key,
});

const [sourceCountsAfter, targetCounts] = await Promise.all([
  withClient(sourceUrl, inspectTableCounts),
  withClient(targetUrl, inspectTableCounts),
]);
const sourceStable = JSON.stringify(sourceCountsBefore) === JSON.stringify(sourceCountsAfter);
const countsMatch = JSON.stringify(sourceCountsAfter) === JSON.stringify(targetCounts);
const summary = {
  success: sourceStable && countsMatch,
  test: "encrypted-neon-backup-and-restore-to-separate-empty-branch",
  source: { ...sourceIdentity, tableCount: Object.keys(sourceCountsAfter).length },
  target: { ...targetIdentity, tableCount: Object.keys(targetCounts).length },
  sourceUnchangedDuringDrill: sourceStable,
  exactTableRowCountsMatch: countsMatch,
  backup: { path: backupPath, bytes: backupStat.size, aes256Gcm: true },
  tableCounts: targetCounts,
  note: "Run during a write-quiescent window. This verifies encrypted logical backup/restore and table row counts, not point-in-time recovery or physical Neon storage backups.",
};
console.log(JSON.stringify(summary, null, 2));
if (!sourceStable || !countsMatch) process.exitCode = 2;
