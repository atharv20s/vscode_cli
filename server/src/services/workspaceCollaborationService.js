import crypto from "crypto";
import { getDatabase } from "../db/database.js";
import { getPostgresPool } from "../db/postgres.js";

const hashToken = token => crypto.createHash("sha256").update(token).digest("hex");
const pool = () => getPostgresPool();

export async function createWorkspaceShare({ ownerUserId, workspaceId = "default", permission = "edit", expiresInHours = 168 }) {
  if (!ownerUserId || typeof workspaceId !== "string" || !workspaceId || workspaceId.length > 128) throw new Error("Invalid workspace share target.");
  if (!["view", "edit"].includes(permission)) throw new Error("Permission must be view or edit.");
  const hours = Number(expiresInHours);
  if (!Number.isFinite(hours) || hours < 0 || hours > 720) throw new Error("Share expiry must be between 0 and 720 hours.");
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = hours === 0 ? null : new Date(Date.now() + hours * 3600000).toISOString();
  if (pool()) {
    await pool().query(
      "INSERT INTO workspace_shares (id,owner_user_id,workspace_id,token_hash,permission,expires_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, ownerUserId, workspaceId, tokenHash, permission, expiresAt]
    );
  } else {
    getDatabase().prepare(
      "INSERT INTO workspace_shares (id,owner_user_id,workspace_id,token_hash,permission,expires_at) VALUES (?,?,?,?,?,?)"
    ).run(id, ownerUserId, workspaceId, tokenHash, permission, expiresAt);
  }
  return { id, workspaceId, permission, expiresAt, token };
}

export async function resolveWorkspaceShare(token) {
  if (typeof token !== "string" || token.length < 32 || token.length > 256) return null;
  const tokenHash = hashToken(token);
  let row;
  if (pool()) {
    const result = await pool().query(
      "SELECT id,owner_user_id,workspace_id,permission,expires_at FROM workspace_shares WHERE token_hash=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)",
      [tokenHash]
    );
    row = result.rows[0];
  } else {
    row = getDatabase().prepare(
      "SELECT id,owner_user_id,workspace_id,permission,expires_at FROM workspace_shares WHERE token_hash=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > datetime('now'))"
    ).get(tokenHash);
  }
  return row ? { id: row.id, ownerUserId: row.owner_user_id, workspaceId: row.workspace_id, permission: row.permission, expiresAt: row.expires_at } : null;
}

export async function listWorkspaceShares(ownerUserId, workspaceId = "default") {
  if (pool()) {
    const result = await pool().query(
      "SELECT id,workspace_id AS \"workspaceId\",permission,expires_at AS \"expiresAt\",created_at AS \"createdAt\",revoked_at AS \"revokedAt\" FROM workspace_shares WHERE owner_user_id=$1 AND workspace_id=$2 ORDER BY created_at DESC",
      [ownerUserId, workspaceId]
    );
    return result.rows;
  }
  return getDatabase().prepare(
    "SELECT id,workspace_id AS workspaceId,permission,expires_at AS expiresAt,created_at AS createdAt,revoked_at AS revokedAt FROM workspace_shares WHERE owner_user_id=? AND workspace_id=? ORDER BY created_at DESC"
  ).all(ownerUserId, workspaceId);
}

export async function revokeWorkspaceShare(ownerUserId, shareId) {
  if (pool()) {
    const result = await pool().query(
      "UPDATE workspace_shares SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1 AND owner_user_id=$2 AND revoked_at IS NULL RETURNING id",
      [shareId, ownerUserId]
    );
    return result.rowCount > 0;
  }
  return getDatabase().prepare(
    "UPDATE workspace_shares SET revoked_at=datetime('now') WHERE id=? AND owner_user_id=? AND revoked_at IS NULL"
  ).run(shareId, ownerUserId).changes > 0;
}
