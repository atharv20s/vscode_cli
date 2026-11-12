/**
 * SQLite Database Layer
 *
 * Uses better-sqlite3 for synchronous, fast, zero-config persistence.
 * Tables: users, sessions, conversations, cache_entries
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { config } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "../../data/agentic.db");

/** @type {Database.Database | null} */
let db = null;

/**
 * Initialize the database — creates tables if they don't exist.
 * @returns {Database.Database}
 */
export function initDatabase() {
  if (db) return db;

  // Ensure data directory exists
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  db = new Database(DB_PATH);

  // Enable WAL mode for concurrent read performance
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      github_id INTEGER UNIQUE,
      username TEXT NOT NULL UNIQUE,
      email TEXT UNIQUE,
      password_hash TEXT,
      avatar_url TEXT,
      github_access_token TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_path TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      last_active TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT,
      title TEXT,
      messages TEXT DEFAULT '[]',
      model TEXT,
      total_tokens INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS repo_agent_tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      branch TEXT NOT NULL,
      prompt TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      events_json TEXT NOT NULL DEFAULT '[]',
      pr_url TEXT,
      pr_number INTEGER,
      error TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      worker_id TEXT,
      lease_expires_at TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      github_token_ciphertext TEXT,
      github_token_iv TEXT,
      github_token_tag TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_repo_agent_tasks_user
      ON repo_agent_tasks(user_id, created_at DESC);
    
    CREATE TABLE IF NOT EXISTS repo_agent_context_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES repo_agent_tasks(id) ON DELETE CASCADE,
      round_number INTEGER NOT NULL,
      agent_role TEXT NOT NULL,
      status TEXT NOT NULL,
      input_summary TEXT,
      output_summary TEXT,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(task_id, round_number, agent_role)
    );

    CREATE TABLE IF NOT EXISTS repo_agent_shares (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES repo_agent_tasks(id) ON DELETE CASCADE,
      owner_user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      permission TEXT NOT NULL CHECK (permission IN ('view','comment','edit')),
      expires_at TEXT,
      revoked_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS repo_agent_share_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      share_id TEXT NOT NULL REFERENCES repo_agent_shares(id) ON DELETE CASCADE,
      author_label TEXT NOT NULL DEFAULT 'Collaborator',
      body TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_repo_agent_rounds_task
      ON repo_agent_context_rounds(task_id, round_number);
    CREATE INDEX IF NOT EXISTS idx_repo_agent_shares_task
      ON repo_agent_shares(task_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS cache_entries (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      ttl_seconds INTEGER DEFAULT 300,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id);
    CREATE INDEX IF NOT EXISTS idx_cache_created ON cache_entries(created_at);
  `);

  // Run safe migrations (ignore errors on already-existing columns)
  const migrations = [
    "ALTER TABLE users ADD COLUMN password_hash TEXT;",
    "ALTER TABLE conversations ADD COLUMN user_id TEXT;",
    "ALTER TABLE repo_agent_tasks ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE repo_agent_tasks ADD COLUMN worker_id TEXT;",
    "ALTER TABLE repo_agent_tasks ADD COLUMN lease_expires_at TEXT;",
    "ALTER TABLE repo_agent_tasks ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE repo_agent_tasks ADD COLUMN github_token_ciphertext TEXT;",
    "ALTER TABLE repo_agent_tasks ADD COLUMN github_token_iv TEXT;",
    "ALTER TABLE repo_agent_tasks ADD COLUMN github_token_tag TEXT;",
    "CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);",
  ];
  for (const migration of migrations) {
    try { db.exec(migration); } catch {}
  }

  return db;
}

/**
 * Get the database instance.
 * @returns {Database.Database}
 */
export function getDatabase() {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return db;
}

// ============================================
// User queries
// ============================================

export function findUserByGithubId(githubId) {
  return getDatabase().prepare("SELECT * FROM users WHERE github_id = ?").get(githubId);
}

export function findUserById(id) {
  return getDatabase().prepare("SELECT * FROM users WHERE id = ?").get(id);
}

export function findUserByUsername(username) {
  return getDatabase().prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username);
}

export function findUserByEmail(email) {
  return getDatabase().prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email);
}

export function createUser({ id, githubId, username, email, passwordHash, avatarUrl, githubAccessToken }) {
  return getDatabase()
    .prepare(
      `INSERT INTO users (id, github_id, username, email, password_hash, avatar_url, github_access_token)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, githubId || null, username, email || null, passwordHash || null, avatarUrl || null, githubAccessToken || null);
}

export function updateUserToken(userId, githubAccessToken) {
  return getDatabase()
    .prepare("UPDATE users SET github_access_token = ?, updated_at = datetime('now') WHERE id = ?")
    .run(githubAccessToken, userId);
}

export function updateUserProfile(userId, { avatarUrl, githubId, githubAccessToken }) {
  if (githubId) {
    // Clear old duplicate github_id from any prior dummy user record
    try {
      getDatabase()
        .prepare("UPDATE users SET github_id = NULL, github_access_token = NULL WHERE github_id = ? AND id != ?")
        .run(githubId, userId);
    } catch {}
  }

  return getDatabase()
    .prepare(
      `UPDATE users SET 
        avatar_url = COALESCE(?, avatar_url),
        github_id = COALESCE(?, github_id),
        github_access_token = COALESCE(?, github_access_token),
        updated_at = datetime('now') 
       WHERE id = ?`
    )
    .run(avatarUrl || null, githubId || null, githubAccessToken || null, userId);
}

// ============================================
// Session queries
// ============================================

export function createSession({ id, userId, workspacePath }) {
  return getDatabase()
    .prepare("INSERT INTO sessions (id, user_id, workspace_path) VALUES (?, ?, ?)")
    .run(id, userId, workspacePath);
}

export function touchSession(sessionId) {
  return getDatabase()
    .prepare("UPDATE sessions SET last_active = datetime('now') WHERE id = ?")
    .run(sessionId);
}

// ============================================
// Conversation queries
// ============================================

/**
 * Find or create a session for a given user (needed for WS connections).
 */
export function findOrCreateUserSession(sessionId, userId) {
  const sid = sessionId || `sess_${Date.now()}`;
  try {
    const existing = getDatabase().prepare("SELECT id FROM sessions WHERE id = ?").get(sid);
    if (!existing) {
      // Ensure user record exists
      const uid = userId || "usr_default_guest";
      getDatabase()
        .prepare("INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)")
        .run(uid, uid.startsWith("usr_") ? uid : "guest", null);
      getDatabase()
        .prepare("INSERT OR IGNORE INTO sessions (id, user_id) VALUES (?, ?)")
        .run(sid, uid);
    }
    return sid;
  } catch {
    return sid;
  }
}

export function createConversation({ id, sessionId, userId, title, model }) {
  const sid = sessionId || "default_session";

  // Ensure default user and session exist so foreign key never fails
  try {
    const existingSession = getDatabase().prepare("SELECT id FROM sessions WHERE id = ?").get(sid);
    if (!existingSession) {
      const uid = userId || "usr_default_guest";
      getDatabase().prepare("INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)").run(uid, "guest", "guest@local.studio");
      getDatabase().prepare("INSERT OR IGNORE INTO sessions (id, user_id) VALUES (?, ?)").run(sid, uid);
    }
  } catch {}

  return getDatabase()
    .prepare("INSERT INTO conversations (id, session_id, user_id, title, model) VALUES (?, ?, ?, ?, ?)")
    .run(id, sid, userId || null, title, model);
}

export function getConversation(id) {
  return getDatabase().prepare("SELECT * FROM conversations WHERE id = ?").get(id);
}

export function getConversationForUser(id, userId) {
  if (!id || !userId) return null;
  return getDatabase().prepare("SELECT * FROM conversations WHERE id = ? AND user_id = ?").get(id, userId);
}

export function updateConversationMessagesForUser(id, messages, totalTokens, userId) {
  if (!id || !userId) return { changes: 0 };
  return getDatabase()
    .prepare(
      `UPDATE conversations SET messages = ?, total_tokens = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`
    )
    .run(JSON.stringify(messages), totalTokens, id, userId);
}

export function updateConversationMessages(id, messages, totalTokens) {
  return getDatabase()
    .prepare(
      `UPDATE conversations SET messages = ?, total_tokens = ?, updated_at = datetime('now') WHERE id = ?`
    )
    .run(JSON.stringify(messages), totalTokens, id);
}

export function updateConversationTitle(id, title, userId = null) {
  if (!userId) return { changes: 0 };
  return getDatabase()
    .prepare("UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .run(title, id, userId);
}

export function deleteConversation(id, userId = null) {
  if (!userId) return { changes: 0 };
  return getDatabase().prepare("DELETE FROM conversations WHERE id = ? AND user_id = ?").run(id, userId);
}

export function listConversations(userId) {
  if (!userId) return [];
  return getDatabase()
    .prepare(`
      SELECT id, title, model, total_tokens, messages, created_at, updated_at
      FROM conversations
      WHERE user_id = ?
      ORDER BY updated_at DESC
      LIMIT 100
    `)
    .all(userId);
}

// ============================================
// Cache queries
// ============================================

export function getCacheEntry(key) {
  const row = getDatabase()
    .prepare("SELECT * FROM cache_entries WHERE key = ?")
    .get(key);

  if (!row) return null;

  // Check if expired
  const createdAt = new Date(row.created_at).getTime();
  const now = Date.now();
  if (now - createdAt > row.ttl_seconds * 1000) {
    getDatabase().prepare("DELETE FROM cache_entries WHERE key = ?").run(key);
    return null;
  }

  return JSON.parse(row.value);
}

export function setCacheEntry(key, value, ttlSeconds = 300) {
  getDatabase()
    .prepare(
      `INSERT OR REPLACE INTO cache_entries (key, value, ttl_seconds, created_at)
       VALUES (?, ?, ?, datetime('now'))`
    )
    .run(key, JSON.stringify(value), ttlSeconds);
}

export function clearExpiredCache() {
  return getDatabase()
    .prepare(
      `DELETE FROM cache_entries
       WHERE (julianday('now') - julianday(created_at)) * 86400 > ttl_seconds`
    )
    .run();
}

/**
 * Close the database connection gracefully.
 */
export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}
