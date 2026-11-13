CREATE TABLE IF NOT EXISTS workspace_shares (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  permission TEXT NOT NULL CHECK (permission IN ('view','edit')),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_workspace_shares_owner_workspace
  ON workspace_shares(owner_user_id, workspace_id, created_at DESC);
