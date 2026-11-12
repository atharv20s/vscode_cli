import { getDatabase, findUserById } from "../db/database.js";
import { getPostgresPool } from "../db/postgres.js";

function pool() { return getPostgresPool(); }

export async function countActiveRepoTasks(userId) {
  if (pool()) {
    const result = await pool().query(
      "SELECT COUNT(*)::int AS count FROM repo_agent_tasks WHERE user_id = $1 AND status IN ('queued','cloning','running','testing','reviewing','publishing')",
      [userId]
    );
    return result.rows[0]?.count || 0;
  }
  return getDatabase().prepare(
    "SELECT COUNT(*) AS count FROM repo_agent_tasks WHERE user_id = ? AND status IN ('queued','cloning','running','testing','reviewing','publishing')"
  ).get(userId).count;
}

export async function createRepoTask(task) {
  if (pool()) {
    const result = await pool().query(
      "INSERT INTO repo_agent_tasks (id,user_id,owner,repo,base_branch,base_sha,branch,prompt,workspace_path,status,events_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'','queued','[]'::jsonb) RETURNING *",
      [task.id,task.userId,task.owner,task.repo,task.baseBranch,task.baseSha,task.branch,task.prompt]
    );
    return result.rows[0];
  }
  getDatabase().prepare(
    "INSERT INTO repo_agent_tasks (id,user_id,owner,repo,base_branch,base_sha,branch,prompt,workspace_path,status,events_json) VALUES (?,?,?,?,?,?,?,?,?,'queued','[]')"
  ).run(task.id,task.userId,task.owner,task.repo,task.baseBranch,task.baseSha,task.branch,task.prompt,task.workspacePath || "");
  return getDatabase().prepare("SELECT * FROM repo_agent_tasks WHERE id = ?").get(task.id);
}

export async function getRepoTask(taskId, userId = null) {
  if (pool()) {
    const result = userId
      ? await pool().query("SELECT * FROM repo_agent_tasks WHERE id = $1 AND user_id = $2", [taskId,userId])
      : await pool().query("SELECT * FROM repo_agent_tasks WHERE id = $1", [taskId]);
    return result.rows[0] || null;
  }
  return userId
    ? getDatabase().prepare("SELECT * FROM repo_agent_tasks WHERE id = ? AND user_id = ?").get(taskId,userId) || null
    : getDatabase().prepare("SELECT * FROM repo_agent_tasks WHERE id = ?").get(taskId) || null;
}

export async function listRepoTasks(userId, limit = 25) {
  if (pool()) {
    const result = await pool().query(
      "SELECT * FROM repo_agent_tasks WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
      [userId,limit]
    );
    return result.rows;
  }
  return getDatabase().prepare(
    "SELECT * FROM repo_agent_tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"
  ).all(userId,limit);
}

export async function updateRepoTask(taskId, patch) {
  const allowed = new Set(["status","events_json","pr_url","pr_number","error","workspace_path","attempt_count","worker_id","lease_expires_at","cancel_requested"]);
  const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
  if (!entries.length) return;
  if (pool()) {
    const columns = { events_json: "events_json", lease_expires_at: "lease_expires_at", cancel_requested: "cancel_requested" };
    const assignments = entries.map(([key],i) => (columns[key] || key) + " = $" + (i+1)).join(", ");
    const values = entries.map(([key,value]) => key === "events_json" ? JSON.stringify(value) : value);
    await pool().query(
      "UPDATE repo_agent_tasks SET " + assignments + ", updated_at = CURRENT_TIMESTAMP WHERE id = $" + (entries.length+1),
      values.concat([taskId])
    );
    return;
  }
  const assignments = entries.map(([key]) => key + " = ?").join(", ");
  getDatabase().prepare(
    "UPDATE repo_agent_tasks SET " + assignments + ", updated_at = datetime('now') WHERE id = ?"
  ).run(...entries.map(([,value]) => value),taskId);
}

export async function appendRepoTaskEvent(taskId, event) {
  const row = await getRepoTask(taskId);
  if (!row) return;
  let events = [];
  try { events = Array.isArray(row.events_json) ? row.events_json : JSON.parse(row.events_json || "[]"); } catch {}
  events.push({
    at: new Date().toISOString(),
    type: String(event.type || "event").slice(0,64),
    data: event.data && typeof event.data === "object" ? event.data : {},
  });
  if (events.length > 300) events = events.slice(-300);
  await updateRepoTask(taskId, { events_json: events });
}

export async function getRepoTaskGithubToken(userId) {
  if (pool()) {
    const result = await pool().query("SELECT github_access_token FROM users WHERE id = $1", [userId]);
    return result.rows[0]?.github_access_token || "";
  }
  return findUserById(userId)?.github_access_token || "";
}

export async function saveRepoContextRound(taskId, round) {
  const values = [taskId,round.roundNumber,round.role,round.status,round.inputSummary || null,round.outputSummary || null];
  if (pool()) {
    await pool().query(
      "INSERT INTO repo_agent_context_rounds (task_id,round_number,agent_role,status,input_summary,output_summary,evidence) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (task_id,round_number,agent_role) DO UPDATE SET status=EXCLUDED.status,input_summary=EXCLUDED.input_summary,output_summary=EXCLUDED.output_summary,evidence=EXCLUDED.evidence",
      values.concat([JSON.stringify(round.evidence || {})])
    );
    return;
  }
  getDatabase().prepare(
    "INSERT INTO repo_agent_context_rounds (task_id,round_number,agent_role,status,input_summary,output_summary,evidence_json) VALUES (?,?,?,?,?,?,?) ON CONFLICT(task_id,round_number,agent_role) DO UPDATE SET status=excluded.status,input_summary=excluded.input_summary,output_summary=excluded.output_summary,evidence_json=excluded.evidence_json"
  ).run(...values,JSON.stringify(round.evidence || {}));
}

export async function listRepoContextRounds(taskId) {
  if (pool()) {
    return (await pool().query(
      "SELECT round_number,agent_role,status,input_summary,output_summary,evidence,created_at FROM repo_agent_context_rounds WHERE task_id=$1 ORDER BY round_number,id",
      [taskId]
    )).rows;
  }
  return getDatabase().prepare(
    "SELECT round_number,agent_role,status,input_summary,output_summary,evidence_json AS evidence,created_at FROM repo_agent_context_rounds WHERE task_id=? ORDER BY round_number,id"
  ).all(taskId);
}

export async function createRepoShare({ id, taskId, ownerUserId, tokenHash, permission, expiresAt }) {
  if (pool()) {
    const result = await pool().query(
      "INSERT INTO repo_agent_shares (id,task_id,owner_user_id,token_hash,permission,expires_at) SELECT $1,$2,$3,$4,$5,$6 WHERE EXISTS (SELECT 1 FROM repo_agent_tasks WHERE id=$2 AND user_id=$3) RETURNING id,task_id,permission,expires_at,created_at",
      [id,taskId,ownerUserId,tokenHash,permission,expiresAt]
    );
    return result.rows[0] || null;
  }
  const task = await getRepoTask(taskId,ownerUserId);
  if (!task) return null;
  getDatabase().prepare(
    "INSERT INTO repo_agent_shares (id,task_id,owner_user_id,token_hash,permission,expires_at) VALUES (?,?,?,?,?,?)"
  ).run(id,taskId,ownerUserId,tokenHash,permission,expiresAt || null);
  return getDatabase().prepare("SELECT id,task_id,permission,expires_at,created_at FROM repo_agent_shares WHERE id=?").get(id);
}

export async function getRepoShareByHash(tokenHash) {
  if (pool()) {
    const result = await pool().query(
      "SELECT s.*,t.owner,t.repo,t.base_branch,t.branch,t.prompt,t.status,t.events_json,t.pr_url,t.pr_number,t.error,t.created_at AS task_created_at FROM repo_agent_shares s JOIN repo_agent_tasks t ON t.id=s.task_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > CURRENT_TIMESTAMP)",
      [tokenHash]
    );
    return result.rows[0] || null;
  }
  return getDatabase().prepare(
    "SELECT s.*,t.owner,t.repo,t.base_branch,t.branch,t.prompt,t.status,t.events_json,t.pr_url,t.pr_number,t.error,t.created_at AS task_created_at FROM repo_agent_shares s JOIN repo_agent_tasks t ON t.id=s.task_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > datetime('now'))"
  ).get(tokenHash) || null;
}

export async function listRepoShares(taskId, ownerUserId) {
  if (pool()) {
    return (await pool().query(
      "SELECT id,permission,expires_at,revoked_at,created_at FROM repo_agent_shares WHERE task_id=$1 AND owner_user_id=$2 ORDER BY created_at DESC",
      [taskId,ownerUserId]
    )).rows;
  }
  return getDatabase().prepare(
    "SELECT id,permission,expires_at,revoked_at,created_at FROM repo_agent_shares WHERE task_id=? AND owner_user_id=? ORDER BY created_at DESC"
  ).all(taskId,ownerUserId);
}

export async function revokeRepoShare(shareId, ownerUserId) {
  if (pool()) {
    const result = await pool().query(
      "UPDATE repo_agent_shares SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1 AND owner_user_id=$2 AND revoked_at IS NULL",
      [shareId,ownerUserId]
    );
    return result.rowCount > 0;
  }
  return getDatabase().prepare(
    "UPDATE repo_agent_shares SET revoked_at=datetime('now') WHERE id=? AND owner_user_id=? AND revoked_at IS NULL"
  ).run(shareId,ownerUserId).changes > 0;
}

export async function addRepoShareComment(shareId, authorLabel, body) {
  if (pool()) {
    const result = await pool().query(
      "INSERT INTO repo_agent_share_comments (share_id,author_label,body) VALUES ($1,$2,$3) RETURNING id,author_label,body,created_at",
      [shareId,authorLabel,body]
    );
    return result.rows[0];
  }
  const info = getDatabase().prepare(
    "INSERT INTO repo_agent_share_comments (share_id,author_label,body) VALUES (?,?,?)"
  ).run(shareId,authorLabel,body);
  return getDatabase().prepare("SELECT id,author_label,body,created_at FROM repo_agent_share_comments WHERE id=?").get(info.lastInsertRowid);
}

export async function listRepoShareComments(shareId) {
  if (pool()) {
    return (await pool().query(
      "SELECT id,author_label,body,created_at FROM repo_agent_share_comments WHERE share_id=$1 ORDER BY created_at",
      [shareId]
    )).rows;
  }
  return getDatabase().prepare(
    "SELECT id,author_label,body,created_at FROM repo_agent_share_comments WHERE share_id=? ORDER BY created_at"
  ).all(shareId);
}
