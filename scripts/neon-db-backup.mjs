#!/usr/bin/env node
/**
 * Encrypted Neon logical backup/restore.
 *
 * Backup: DIRECT_DATABASE_URL=... NEON_BACKUP_KEY=<64 hex chars> node scripts/neon-db-backup.mjs backup [file]
 * Restore: RESTORE_DATABASE_URL=... RESTORE_CONFIRM_EMPTY_TARGET=YES NEON_BACKUP_KEY=<64 hex chars> node scripts/neon-db-backup.mjs restore <file>
 *
 * The archive is streamed directly through AES-256-GCM; plaintext dumps are
 * never written to disk. Restore deliberately does not use pg_restore --clean.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("ATHPGBAK1");
const IV_BYTES = 12;
const TAG_BYTES = 16;

function readKey() {
  const value = process.env.NEON_BACKUP_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("NEON_BACKUP_KEY must be a 64-character hexadecimal AES-256 key.");
  }
  return Buffer.from(value, "hex");
}

function parseDatabaseUrl(value, variableName) {
  if (!value) throw new Error(variableName + " is required.");
  let url;
  try { url = new URL(value); } catch { throw new Error(variableName + " is not a valid PostgreSQL URL."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error(variableName + " must use PostgreSQL.");
  if (!url.hostname || !url.username || !url.password || !url.pathname || url.pathname === "/") {
    throw new Error(variableName + " must include host, database, username and password.");
  }
  if (url.searchParams.get("sslmode") === "disable") throw new Error("TLS cannot be disabled for Neon backups.");
  const env = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGSSLMODE: "verify-full",
  };
  const channelBinding = url.searchParams.get("channel_binding");
  if (channelBinding) env.PGCHANNELBINDING = channelBinding;
  return { env, host: url.hostname, database: env.PGDATABASE };
}

function runProcess(command, args, env) {
  const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", chunk => {
    if (stderr.length < 12000) stderr += chunk.toString("utf8").slice(0, 12000 - stderr.length);
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, stderr: () => stderr, closed };
}

async function backup(outputPath) {
  const key = readKey();
  const database = parseDatabaseUrl(process.env.DIRECT_DATABASE_URL, "DIRECT_DATABASE_URL");
  const target = path.resolve(outputPath || path.join("backups", "neon-" + new Date().toISOString().replace(/[:.]/g, "-") + ".athpg"));
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = target + "." + process.pid + ".tmp";
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const child = runProcess("pg_dump", [
    "--format=custom", "--no-owner", "--no-acl", "--compress=6", "--no-password",
    "--dbname=" + database.database,
  ], database.env);
  try {
    await fsp.writeFile(temporary, Buffer.concat([MAGIC, iv]), { flag: "wx", mode: 0o600 });
    await pipeline(child.child.stdout, cipher, fs.createWriteStream(temporary, { flags: "a", mode: 0o600 }));
    const result = await child.closed;
    if (result.code !== 0) throw new Error("pg_dump failed (" + result.code + "): " + child.stderr().trim());
    await fsp.appendFile(temporary, cipher.getAuthTag());
    await fsp.rename(temporary, target);
    console.log(JSON.stringify({ success: true, backup: target, database: database.database, host: database.host, encrypted: true }));
  } catch (error) {
    child.child.kill("SIGTERM");
    await child.closed.catch(() => {});
    await fsp.unlink(temporary).catch(() => {});
    throw error;
  }
}

class AuthTagTail extends Transform {
  constructor(decipher) {
    super();
    this.decipher = decipher;
    this.tail = Buffer.alloc(0);
  }
  _transform(chunk, _encoding, callback) {
    const combined = Buffer.concat([this.tail, chunk]);
    if (combined.length <= TAG_BYTES) {
      this.tail = combined;
      callback();
      return;
    }
    const splitAt = combined.length - TAG_BYTES;
    this.push(combined.subarray(0, splitAt));
    this.tail = combined.subarray(splitAt);
    callback();
  }
  _flush(callback) {
    if (this.tail.length !== TAG_BYTES) {
      callback(new Error("Backup is truncated or has an invalid authentication tag."));
      return;
    }
    try {
      this.decipher.setAuthTag(this.tail);
      callback();
    } catch (error) { callback(error); }
  }
}

async function restore(inputPath) {
  if (process.env.RESTORE_CONFIRM_EMPTY_TARGET !== "YES") {
    throw new Error("Refusing restore: set RESTORE_CONFIRM_EMPTY_TARGET=YES only after confirming this is a separate, empty restore database/branch.");
  }
  const key = readKey();
  const database = parseDatabaseUrl(process.env.RESTORE_DATABASE_URL, "RESTORE_DATABASE_URL");
  const source = path.resolve(inputPath || "");
  if (!inputPath) throw new Error("A backup file path is required.");
  const stat = await fsp.stat(source);
  if (stat.size < MAGIC.length + IV_BYTES + TAG_BYTES) throw new Error("Backup file is too small or truncated.");
  const header = Buffer.alloc(MAGIC.length + IV_BYTES);
  const handle = await fsp.open(source, "r");
  try {
    await handle.read(header, 0, header.length, 0);
  } finally { await handle.close(); }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Unsupported backup format.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, header.subarray(MAGIC.length));
  const tail = new AuthTagTail(decipher);
  const child = runProcess("pg_restore", [
    "--format=custom", "--exit-on-error", "--single-transaction", "--no-owner", "--no-acl",
    "--dbname=" + database.database,
  ], database.env);
  try {
    await pipeline(fs.createReadStream(source, { start: header.length }), tail, decipher, child.child.stdin);
    const result = await child.closed;
    if (result.code !== 0) throw new Error("pg_restore failed (" + result.code + "): " + child.stderr().trim());
    console.log(JSON.stringify({ success: true, restoredTo: database.database, host: database.host, encryptedArchiveVerified: true }));
  } catch (error) {
    child.child.kill("SIGTERM");
    await child.closed.catch(() => {});
    throw error;
  }
}

const [operation, filePath] = process.argv.slice(2);
try {
  if (operation === "backup") await backup(filePath);
  else if (operation === "restore") await restore(filePath);
  else throw new Error("Usage: node scripts/neon-db-backup.mjs backup [output.athpg] | restore <input.athpg>");
} catch (error) {
  console.error("Neon backup operation failed:", error.message);
  process.exitCode = 1;
}
