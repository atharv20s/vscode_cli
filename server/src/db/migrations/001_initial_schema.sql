-- Migration 001: Initial Complete Schema for ATH IDE (Neon PostgreSQL)

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 1. Users Table
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) PRIMARY KEY,
  github_id BIGINT UNIQUE,
  username VARCHAR(255) NOT NULL UNIQUE,
  email VARCHAR(255) UNIQUE,
  password_hash TEXT,
  avatar_url TEXT,
  github_access_token TEXT,
  settings JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. Sessions Table
CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_path TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_active TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3. Conversations Table
CREATE TABLE IF NOT EXISTS conversations (
  id VARCHAR(64) PRIMARY KEY,
  session_id VARCHAR(64) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id VARCHAR(64) REFERENCES users(id) ON DELETE CASCADE,
  title TEXT,
  messages JSONB DEFAULT '[]'::jsonb,
  model VARCHAR(255),
  mode VARCHAR(64) DEFAULT 'agent',
  total_tokens INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 5. Terminal Execution History Table
CREATE TABLE IF NOT EXISTS terminal_history (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(64) REFERENCES sessions(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  output TEXT,
  exit_code INTEGER,
  shell VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 6. Workspace Files Tracking Table
CREATE TABLE IF NOT EXISTS workspace_files (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(64) REFERENCES sessions(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  file_size BIGINT DEFAULT 0,
  mime_type VARCHAR(128),
  last_modified TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, file_path)
);

-- 7. Live Preview Instances Table
CREATE TABLE IF NOT EXISTS preview_instances (
  id VARCHAR(64) PRIMARY KEY,
  session_id VARCHAR(64) REFERENCES sessions(id) ON DELETE CASCADE,
  port INTEGER NOT NULL,
  url TEXT NOT NULL,
  status VARCHAR(64) DEFAULT 'running',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 8. LLM Spend and Token Accounting Tables
CREATE TABLE IF NOT EXISTS llm_daily_usage (
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  usage_date DATE NOT NULL,
  spent_usd NUMERIC(18,8) NOT NULL DEFAULT 0,
  reserved_usd NUMERIC(18,8) NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  request_count BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, usage_date)
);

CREATE TABLE IF NOT EXISTS llm_usage_reservations (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  usage_date DATE NOT NULL,
  provider VARCHAR(64) NOT NULL,
  model TEXT NOT NULL,
  reserved_usd NUMERIC(18,8) NOT NULL,
  actual_usd NUMERIC(18,8),
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  settled_at TIMESTAMPTZ
);

-- 9. Cache Entries Table
CREATE TABLE IF NOT EXISTS cache_entries (
  key VARCHAR(255) PRIMARY KEY,
  value TEXT NOT NULL,
  ttl_seconds INTEGER DEFAULT 300,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 10. GitHub Commits & Activity History Table
CREATE TABLE IF NOT EXISTS github_history (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_name VARCHAR(255) NOT NULL,
  commit_sha VARCHAR(64),
  commit_message TEXT,
  branch VARCHAR(128) DEFAULT 'main',
  action VARCHAR(64) DEFAULT 'commit',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 11. Durable Repository-Agent Tasks Table
CREATE TABLE IF NOT EXISTS repo_agent_tasks (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner VARCHAR(255) NOT NULL,
  repo VARCHAR(255) NOT NULL,
  base_branch VARCHAR(255) NOT NULL,
  base_sha VARCHAR(64) NOT NULL,
  branch VARCHAR(255) NOT NULL,
  prompt TEXT NOT NULL,
  workspace_path TEXT NOT NULL DEFAULT '',
  status VARCHAR(40) NOT NULL DEFAULT 'queued',
  events_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  pr_url TEXT,
  pr_number INTEGER,
  error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  worker_id VARCHAR(255),
  lease_expires_at TIMESTAMPTZ,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  github_token_ciphertext TEXT,
  github_token_iv TEXT,
  github_token_tag TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 12. Repository-Agent Context Rounds Table
CREATE TABLE IF NOT EXISTS repo_agent_context_rounds (
  id BIGSERIAL PRIMARY KEY,
  task_id VARCHAR(64) NOT NULL REFERENCES repo_agent_tasks(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL,
  agent_role VARCHAR(32) NOT NULL,
  status VARCHAR(24) NOT NULL,
  input_summary TEXT,
  output_summary TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(task_id, round_number, agent_role)
);

-- 13. Repository-Agent Task Shares Table
CREATE TABLE IF NOT EXISTS repo_agent_shares (
  id VARCHAR(64) PRIMARY KEY,
  task_id VARCHAR(64) NOT NULL REFERENCES repo_agent_tasks(id) ON DELETE CASCADE,
  owner_user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  permission VARCHAR(16) NOT NULL CHECK (permission IN ('view','comment','edit')),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 14. Repository-Agent Share Comments Table
CREATE TABLE IF NOT EXISTS repo_agent_share_comments (
  id BIGSERIAL PRIMARY KEY,
  share_id VARCHAR(64) NOT NULL REFERENCES repo_agent_shares(id) ON DELETE CASCADE,
  author_label VARCHAR(120) NOT NULL DEFAULT 'Collaborator',
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 15. Performance Indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_github ON users(github_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_exec_conv ON tool_executions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_terminal_session ON terminal_history(session_id);
CREATE INDEX IF NOT EXISTS idx_workspace_files_session ON workspace_files(session_id);
CREATE INDEX IF NOT EXISTS idx_preview_session ON preview_instances(session_id);
CREATE INDEX IF NOT EXISTS idx_github_history_user ON github_history(user_id);
CREATE INDEX IF NOT EXISTS idx_cache_created ON cache_entries(created_at);
CREATE INDEX IF NOT EXISTS idx_repo_tasks_user_created ON repo_agent_tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_repo_tasks_status_created ON repo_agent_tasks(status, created_at);
CREATE INDEX IF NOT EXISTS idx_repo_rounds_task ON repo_agent_context_rounds(task_id, round_number);
CREATE INDEX IF NOT EXISTS idx_repo_shares_task ON repo_agent_shares(task_id, created_at DESC);

