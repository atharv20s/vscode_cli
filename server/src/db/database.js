/**
 * Unified Database Layer & Repository Facade for ATH IDE
 *
 * Supports PostgreSQL (Neon, AWS RDS, Supabase) as the primary production
 * database, with fallback to SQLite for local development and offline environments.
 */

let Database = null;
try {
  const mod = await import("better-sqlite3");
  Database = mod.default || mod;
} catch {
  // better-sqlite3 native bindings may not be present on this host
}
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { config } from "../config/env.js";
import { getPostgresPool, getPostgresHealth } from "./postgres.js";
import { logger } from "../config/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "../../data/agentic.db");

/** @type {Database.Database | null} */
let sqliteDb = null;

/**
 * Initialize SQLite database — creates tables if they don't exist.
 * Used for local development or when PostgreSQL is not configured.
 * @returns {Database.Database}
 */
export function initDatabase() {
  if (sqliteDb) return sqliteDb;

  if (!Database) {
    logger.warn("better-sqlite3 is not available in this environment. In production, configure DATABASE_URL for PostgreSQL.");
    return null;
  }

  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    sqliteDb = new Database(DB_PATH);
  } catch (err) {
    logger.warn(`Failed to initialize SQLite database: ${err.message}`);
    sqliteDb = null;
    return null;
  }

  // Enable WAL mode for concurrent read performance
  sqliteDb.pragma("journal_mode = WAL");
  sqliteDb.pragma("foreign_keys = ON");

  // Create tables
  sqliteDb.exec(`
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

    CREATE TABLE IF NOT EXISTS workspace_shares (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      permission TEXT NOT NULL CHECK (permission IN ('view','edit')),
      expires_at TEXT,
      revoked_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_shares_owner_workspace
      ON workspace_shares(owner_user_id, workspace_id, created_at DESC);

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

    CREATE TABLE IF NOT EXISTS llm_daily_usage (
      user_id TEXT NOT NULL,
      usage_date TEXT NOT NULL,
      spent_usd REAL NOT NULL DEFAULT 0,
      reserved_usd REAL NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      request_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, usage_date)
    );

    CREATE TABLE IF NOT EXISTS llm_usage_reservations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      usage_date TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      reserved_usd REAL NOT NULL,
      actual_usd REAL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      settled_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id);
    CREATE INDEX IF NOT EXISTS idx_cache_created ON cache_entries(created_at);
  `);

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
    try { sqliteDb.exec(migration); } catch {}
  }

  return sqliteDb;
}

/**
 * Get the SQLite database instance.
 * @returns {Database.Database}
 */
export function getDatabase() {
  if (!sqliteDb) {
    const initialized = initDatabase();
    if (!initialized) {
      throw new Error("better-sqlite3 is not available in this environment. Configure DATABASE_URL for PostgreSQL.");
    }
  }
  return sqliteDb;
}

/**
 * Check overall database health (Postgres or SQLite).
 */
export async function getDatabaseHealth() {
  const pool = getPostgresPool();
  if (pool) {
    return getPostgresHealth();
  }

  if (sqliteDb) {
    try {
      sqliteDb.prepare("SELECT 1").get();
      return { ok: true, dialect: "sqlite", connected: true };
    } catch (err) {
      return { ok: false, dialect: "sqlite", connected: false, error: err.message };
    }
  }

  return { ok: false, dialect: "none", connected: false, error: "Database not initialized" };
}

// ============================================
// User queries (Async Repository)
// ============================================

export async function findUserByGithubId(githubId) {
  const pool = getPostgresPool();
  if (pool) {
    const res = await pool.query("SELECT * FROM users WHERE github_id = $1", [githubId]);
    return res.rows[0] || null;
  }
  return getDatabase().prepare("SELECT * FROM users WHERE github_id = ?").get(githubId) || null;
}

export async function findUserById(id) {
  const pool = getPostgresPool();
  if (pool) {
    const res = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
    return res.rows[0] || null;
  }
  return getDatabase().prepare("SELECT * FROM users WHERE id = ?").get(id) || null;
}

export async function findUserByUsername(username) {
  const pool = getPostgresPool();
  if (pool) {
    const res = await pool.query("SELECT * FROM users WHERE LOWER(username) = LOWER($1)", [username]);
    return res.rows[0] || null;
  }
  return getDatabase().prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username) || null;
}

export async function findUserByEmail(email) {
  const pool = getPostgresPool();
  if (pool) {
    const res = await pool.query("SELECT * FROM users WHERE LOWER(email) = LOWER($1)", [email]);
    return res.rows[0] || null;
  }
  return getDatabase().prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email) || null;
}

export async function createUser({ id, githubId, username, email, passwordHash, avatarUrl, githubAccessToken }) {
  const pool = getPostgresPool();
  if (pool) {
    await pool.query(
      `INSERT INTO users (id, github_id, username, email, password_hash, avatar_url, github_access_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, githubId || null, username, email || null, passwordHash || null, avatarUrl || null, githubAccessToken || null]
    );
    return { id, username, email };
  }
  return getDatabase()
    .prepare(
      `INSERT INTO users (id, github_id, username, email, password_hash, avatar_url, github_access_token)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, githubId || null, username, email || null, passwordHash || null, avatarUrl || null, githubAccessToken || null);
}

export async function updateUserToken(userId, githubAccessToken) {
  const pool = getPostgresPool();
  if (pool) {
    await pool.query(
      "UPDATE users SET github_access_token = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
      [githubAccessToken, userId]
    );
    return;
  }
  return getDatabase()
    .prepare("UPDATE users SET github_access_token = ?, updated_at = datetime('now') WHERE id = ?")
    .run(githubAccessToken, userId);
}

export async function updateUserProfile(userId, { avatarUrl, githubId, githubAccessToken }) {
  const pool = getPostgresPool();
  if (pool) {
    if (githubId) {
      try {
        await pool.query("UPDATE users SET github_id = NULL, github_access_token = NULL WHERE github_id = $1 AND id != $2", [githubId, userId]);
      } catch {}
    }
    await pool.query(
      `UPDATE users SET 
        avatar_url = COALESCE($1, avatar_url),
        github_id = COALESCE($2, github_id),
        github_access_token = COALESCE($3, github_access_token),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [avatarUrl || null, githubId || null, githubAccessToken || null, userId]
    );
    return;
  }

  if (githubId) {
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

export async function createSession({ id, userId, workspacePath }) {
  const pool = getPostgresPool();
  if (pool) {
    await pool.query(
      "INSERT INTO sessions (id, user_id, workspace_path) VALUES ($1, $2, $3)",
      [id, userId, workspacePath || null]
    );
    return { id, userId };
  }
  return getDatabase()
    .prepare("INSERT INTO sessions (id, user_id, workspace_path) VALUES (?, ?, ?)")
    .run(id, userId, workspacePath);
}

export async function touchSession(sessionId) {
  const pool = getPostgresPool();
  if (pool) {
    await pool.query("UPDATE sessions SET last_active = CURRENT_TIMESTAMP WHERE id = $1", [sessionId]);
    return;
  }
  return getDatabase()
    .prepare("UPDATE sessions SET last_active = datetime('now') WHERE id = ?")
    .run(sessionId);
}

// ============================================
// Conversation queries
// ============================================

export async function findOrCreateUserSession(sessionId, userId) {
  const sid = sessionId || `sess_${Date.now()}`;
  const uid = userId || "usr_default_guest";
  const pool = getPostgresPool();

  if (pool) {
    try {
      const existing = await pool.query("SELECT id FROM sessions WHERE id = $1", [sid]);
      if (existing.rows.length === 0) {
        await pool.query(
          "INSERT INTO users (id, username, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
          [uid, uid.startsWith("usr_") ? uid : "guest", null]
        );
        await pool.query(
          "INSERT INTO sessions (id, user_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
          [sid, uid]
        );
      }
      return sid;
    } catch {
      return sid;
    }
  }

  try {
    const existing = getDatabase().prepare("SELECT id FROM sessions WHERE id = ?").get(sid);
    if (!existing) {
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

export async function createConversation({ id, sessionId, userId, title, model }) {
  const sid = sessionId || "default_session";
  const uid = userId || "usr_default_guest";
  const pool = getPostgresPool();

  if (pool) {
    try {
      const existingSession = await pool.query("SELECT id FROM sessions WHERE id = $1", [sid]);
      if (existingSession.rows.length === 0) {
        await pool.query(
          "INSERT INTO users (id, username, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
          [uid, "guest", "guest@local.studio"]
        );
        await pool.query(
          "INSERT INTO sessions (id, user_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
          [sid, uid]
        );
      }
    } catch {}

    await pool.query(
      `INSERT INTO conversations (id, session_id, user_id, title, model)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, sid, userId || null, title || "New Conversation", model || null]
    );
    return { id, title };
  }

  try {
    const existingSession = getDatabase().prepare("SELECT id FROM sessions WHERE id = ?").get(sid);
    if (!existingSession) {
      getDatabase().prepare("INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)").run(uid, "guest", "guest@local.studio");
      getDatabase().prepare("INSERT OR IGNORE INTO sessions (id, user_id) VALUES (?, ?)").run(sid, uid);
    }
  } catch {}

  return getDatabase()
    .prepare("INSERT INTO conversations (id, session_id, user_id, title, model) VALUES (?, ?, ?, ?, ?)")
    .run(id, sid, userId || null, title, model);
}

export async function getConversation(id) {
  const pool = getPostgresPool();
  if (pool) {
    const res = await pool.query("SELECT * FROM conversations WHERE id = $1", [id]);
    const row = res.rows[0];
    if (row && typeof row.messages === "string") {
      try { row.messages = JSON.parse(row.messages); } catch {}
    }
    return row || null;
  }
  return getDatabase().prepare("SELECT * FROM conversations WHERE id = ?").get(id) || null;
}

export async function getConversationForUser(id, userId) {
  if (!id || !userId) return null;
  const pool = getPostgresPool();
  if (pool) {
    const res = await pool.query("SELECT * FROM conversations WHERE id = $1 AND user_id = $2", [id, userId]);
    const row = res.rows[0];
    if (row && typeof row.messages === "string") {
      try { row.messages = JSON.parse(row.messages); } catch {}
    }
    return row || null;
  }
  return getDatabase().prepare("SELECT * FROM conversations WHERE id = ? AND user_id = ?").get(id, userId) || null;
}

export async function updateConversationMessagesForUser(id, messages, totalTokens, userId) {
  if (!id || !userId) return { changes: 0 };
  const pool = getPostgresPool();
  if (pool) {
    const res = await pool.query(
      `UPDATE conversations
       SET messages = $1::jsonb, total_tokens = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND user_id = $4`,
      [JSON.stringify(messages || []), totalTokens || 0, id, userId]
    );
    return { changes: res.rowCount };
  }
  return getDatabase()
    .prepare(
      `UPDATE conversations SET messages = ?, total_tokens = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`
    )
    .run(JSON.stringify(messages), totalTokens, id, userId);
}

export async function updateConversationMessages(id, messages, totalTokens) {
  const pool = getPostgresPool();
  if (pool) {
    const res = await pool.query(
      `UPDATE conversations
       SET messages = $1::jsonb, total_tokens = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [JSON.stringify(messages || []), totalTokens || 0, id]
    );
    return { changes: res.rowCount };
  }
  return getDatabase()
    .prepare(
      `UPDATE conversations SET messages = ?, total_tokens = ?, updated_at = datetime('now') WHERE id = ?`
    )
    .run(JSON.stringify(messages), totalTokens, id);
}

export async function updateConversationTitle(id, title, userId = null) {
  if (!userId) return { changes: 0 };
  const pool = getPostgresPool();
  if (pool) {
    const res = await pool.query(
      "UPDATE conversations SET title = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND user_id = $3",
      [title, id, userId]
    );
    return { changes: res.rowCount };
  }
  return getDatabase()
    .prepare("UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .run(title, id, userId);
}

export async function deleteConversation(id, userId = null) {
  if (!userId) return { changes: 0 };
  const pool = getPostgresPool();
  if (pool) {
    const res = await pool.query(
      "DELETE FROM conversations WHERE id = $1 AND user_id = $2",
      [id, userId]
    );
    return { changes: res.rowCount };
  }
  return getDatabase().prepare("DELETE FROM conversations WHERE id = ? AND user_id = ?").run(id, userId);
}

export async function listConversations(userId) {
  if (!userId) return [];
  const pool = getPostgresPool();
  if (pool) {
    const res = await pool.query(`
      SELECT id, title, model, total_tokens, messages, created_at, updated_at
      FROM conversations
      WHERE user_id = $1
      ORDER BY updated_at DESC
      LIMIT 100
    `, [userId]);
    return res.rows.map(row => {
      if (typeof row.messages === "string") {
        try { row.messages = JSON.parse(row.messages); } catch {}
      }
      return row;
    });
  }
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

export async function getCacheEntry(key) {
  const pool = getPostgresPool();
  if (pool) {
    const res = await pool.query("SELECT * FROM cache_entries WHERE key = $1", [key]);
    const row = res.rows[0];
    if (!row) return null;
    const createdAt = new Date(row.created_at).getTime();
    if (Date.now() - createdAt > row.ttl_seconds * 1000) {
      await pool.query("DELETE FROM cache_entries WHERE key = $1", [key]).catch(() => {});
      return null;
    }
    try {
      return typeof row.value === "string" ? JSON.parse(row.value) : row.value;
    } catch {
      return row.value;
    }
  }

  const row = getDatabase()
    .prepare("SELECT * FROM cache_entries WHERE key = ?")
    .get(key);

  if (!row) return null;

  const createdAt = new Date(row.created_at).getTime();
  const now = Date.now();
  if (now - createdAt > row.ttl_seconds * 1000) {
    getDatabase().prepare("DELETE FROM cache_entries WHERE key = ?").run(key);
    return null;
  }

  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export async function setCacheEntry(key, value, ttlSeconds = 300) {
  const pool = getPostgresPool();
  if (pool) {
    await pool.query(
      `INSERT INTO cache_entries (key, value, ttl_seconds, created_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, ttl_seconds = EXCLUDED.ttl_seconds, created_at = CURRENT_TIMESTAMP`,
      [key, JSON.stringify(value), ttlSeconds]
    );
    return;
  }
  getDatabase()
    .prepare(
      `INSERT OR REPLACE INTO cache_entries (key, value, ttl_seconds, created_at)
       VALUES (?, ?, ?, datetime('now'))`
    )
    .run(key, JSON.stringify(value), ttlSeconds);
}

export async function clearExpiredCache() {
  const pool = getPostgresPool();
  if (pool) {
    return pool.query(
      `DELETE FROM cache_entries
       WHERE EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - created_at)) > ttl_seconds`
    );
  }
  return getDatabase()
    .prepare(
      `DELETE FROM cache_entries
       WHERE (julianday('now') - julianday(created_at)) * 86400 > ttl_seconds`
    )
    .run();
}

/**
 * Close database connections gracefully.
 */
export function closeDatabase() {
  if (sqliteDb) {
    try { sqliteDb.close(); } catch {}
    sqliteDb = null;
  }
}
