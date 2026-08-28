/**
 * PostgreSQL Database Layer (Neon / Supabase / AWS RDS / Google Cloud SQL)
 *
 * Provides connection pooling, automatic schema initialization, and queries.
 */

import pg from "pg";
import { logger } from "../config/logger.js";

const { Pool } = pg;

let pool = null;

/**
 * Initialize PostgreSQL connection pool and create tables if they do not exist.
 * @param {string} connectionString - e.g. postgresql://user:password@host/db?sslmode=require
 * @returns {Promise<pg.Pool>}
 */
export async function initPostgres(connectionString) {
  if (pool) return pool;

  pool = new Pool({
    connectionString,
    ssl: connectionString.includes("sslmode=require") || connectionString.includes("neon.tech") || connectionString.includes("supabase.co")
      ? { rejectUnauthorized: false }
      : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 20000,
  });

  // Test connection
  const client = await pool.connect();
  try {
    logger.info("Connected to PostgreSQL Database (Neon/Supabase)");

    // Complete Comprehensive Production Schema for ATH IDE
    await client.query(`
      -- 1. Users Table (Email/Password, GitHub OAuth, Guest profiles)
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(64) PRIMARY KEY,
        github_id BIGINT UNIQUE,
        username VARCHAR(255) NOT NULL UNIQUE,
        email VARCHAR(255) UNIQUE,
        password_hash TEXT,
        avatar_url TEXT,
        github_access_token TEXT,
        settings JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 2. Sessions Table (Workspace sessions and client environments)
      CREATE TABLE IF NOT EXISTS sessions (
        id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_path TEXT,
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        last_active TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 3. Conversations Table (AI chat threads, messages JSON, model parameters)
      CREATE TABLE IF NOT EXISTS conversations (
        id VARCHAR(64) PRIMARY KEY,
        session_id VARCHAR(64) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        title TEXT,
        messages JSONB DEFAULT '[]'::jsonb,
        model VARCHAR(255),
        mode VARCHAR(64) DEFAULT 'agent',
        total_tokens INTEGER DEFAULT 0,
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 4. Tool Execution Traces Table
      CREATE TABLE IF NOT EXISTS tool_executions (
        id VARCHAR(64) PRIMARY KEY,
        conversation_id VARCHAR(64) REFERENCES conversations(id) ON DELETE CASCADE,
        tool_name VARCHAR(255) NOT NULL,
        arguments JSONB DEFAULT '{}'::jsonb,
        output TEXT,
        error TEXT,
        duration_ms INTEGER,
        success BOOLEAN DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 5. Terminal Execution History Table
      CREATE TABLE IF NOT EXISTS terminal_history (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(64) REFERENCES sessions(id) ON DELETE CASCADE,
        command TEXT NOT NULL,
        output TEXT,
        exit_code INTEGER,
        shell VARCHAR(64),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 6. Workspace Files Tracking Table
      CREATE TABLE IF NOT EXISTS workspace_files (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(64) REFERENCES sessions(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        file_size BIGINT DEFAULT 0,
        mime_type VARCHAR(128),
        last_modified TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(session_id, file_path)
      );

      -- 7. Live Preview Instances Table
      CREATE TABLE IF NOT EXISTS preview_instances (
        id VARCHAR(64) PRIMARY KEY,
        session_id VARCHAR(64) REFERENCES sessions(id) ON DELETE CASCADE,
        port INTEGER NOT NULL,
        url TEXT NOT NULL,
        status VARCHAR(64) DEFAULT 'running',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 8. Cache Entries Table
      CREATE TABLE IF NOT EXISTS cache_entries (
        key VARCHAR(255) PRIMARY KEY,
        value TEXT NOT NULL,
        ttl_seconds INTEGER DEFAULT 300,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 9. GitHub Commits & Activity History Table
      CREATE TABLE IF NOT EXISTS github_history (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        repo_name VARCHAR(255) NOT NULL,
        commit_sha VARCHAR(64),
        commit_message TEXT,
        branch VARCHAR(128) DEFAULT 'main',
        action VARCHAR(64) DEFAULT 'commit',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- 10. Performance Indexes
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_github ON users(github_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tool_exec_conv ON tool_executions(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_terminal_session ON terminal_history(session_id);
      CREATE INDEX IF NOT EXISTS idx_workspace_files_session ON workspace_files(session_id);
      CREATE INDEX IF NOT EXISTS idx_preview_session ON preview_instances(session_id);
      CREATE INDEX IF NOT EXISTS idx_github_history_user ON github_history(user_id);
      CREATE INDEX IF NOT EXISTS idx_cache_created ON cache_entries(created_at);
    `);
  } finally {
    client.release();
  }

  return pool;
}

/**
 * Get the PostgreSQL pool instance.
 * @returns {pg.Pool}
 */
export function getPostgresPool() {
  return pool;
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
      [sessionId, command, output ? output.slice(0, 10000) : null, exitCode ?? 0, shell || 'powershell']
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
      [userId, repoName, commitSha || null, commitMessage || 'Auto-commit', branch || 'main', action || 'commit']
    );
  } catch (err) {
    logger.debug(`recordGithubCommit: ${err.message}`);
  }
}
