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
      title TEXT,
      messages TEXT DEFAULT '[]',
      model TEXT,
      total_tokens INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

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

  try {
    db.exec("ALTER TABLE users ADD COLUMN password_hash TEXT;");
  } catch {}

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

export function createConversation({ id, sessionId, title, model }) {
  const sid = sessionId || "default_session";

  // Ensure default user and session exist so foreign key never fails
  try {
    const existingSession = getDatabase().prepare("SELECT id FROM sessions WHERE id = ?").get(sid);
    if (!existingSession) {
      const defaultUser = getDatabase().prepare("SELECT id FROM users LIMIT 1").get();
      const userId = defaultUser ? defaultUser.id : "usr_default_guest";
      getDatabase().prepare("INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)").run(userId, "guest", "guest@local.studio");
      getDatabase().prepare("INSERT OR IGNORE INTO sessions (id, user_id) VALUES (?, ?)").run(sid, userId);
    }
  } catch {}

  return getDatabase()
    .prepare("INSERT INTO conversations (id, session_id, title, model) VALUES (?, ?, ?, ?)")
    .run(id, sid, title, model);
}

export function getConversation(id) {
  return getDatabase().prepare("SELECT * FROM conversations WHERE id = ?").get(id);
}

export function updateConversationMessages(id, messages, totalTokens) {
  return getDatabase()
    .prepare(
      `UPDATE conversations SET messages = ?, total_tokens = ?, updated_at = datetime('now') WHERE id = ?`
    )
    .run(JSON.stringify(messages), totalTokens, id);
}

export function updateConversationTitle(id, title) {
  return getDatabase()
    .prepare("UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?")
    .run(title, id);
}

export function deleteConversation(id) {
  return getDatabase().prepare("DELETE FROM conversations WHERE id = ?").run(id);
}

export function listConversations(userIdOrSessionId) {
  if (userIdOrSessionId) {
    return getDatabase()
      .prepare(`
        SELECT c.id, c.title, c.model, c.total_tokens, c.messages, c.created_at, c.updated_at
        FROM conversations c
        LEFT JOIN sessions s ON c.session_id = s.id
        WHERE c.session_id = ? OR s.user_id = ? OR s.id = ?
        ORDER BY c.updated_at DESC
        LIMIT 100
      `)
      .all(userIdOrSessionId, userIdOrSessionId, userIdOrSessionId);
  }
  return getDatabase()
    .prepare("SELECT id, title, model, total_tokens, messages, created_at, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 50")
    .all();
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
