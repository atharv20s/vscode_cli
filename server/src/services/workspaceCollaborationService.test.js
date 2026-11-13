import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { initDatabase, getDatabase } from "../db/database.js";
import { getPostgresPool } from "../db/postgres.js";
import {
  createWorkspaceShare,
  resolveWorkspaceShare,
  listWorkspaceShares,
  revokeWorkspaceShare,
} from "./workspaceCollaborationService.js";

test("workspace collaboration links are hashed, scoped, listable and revocable", async () => {
  initDatabase();
  const ownerUserId = "collab-test-" + crypto.randomUUID();
  const workspaceId = "workspace-" + crypto.randomUUID();
  const share = await createWorkspaceShare({
    ownerUserId,
    workspaceId,
    permission: "edit",
    expiresInHours: 1,
  });

  try {
    assert.equal(share.permission, "edit");
    assert.ok(share.token.length >= 40);
    const resolved = await resolveWorkspaceShare(share.token);
    assert.equal(resolved.ownerUserId, ownerUserId);
    assert.equal(resolved.workspaceId, workspaceId);
    assert.equal(resolved.permission, "edit");

    const listed = await listWorkspaceShares(ownerUserId, workspaceId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, share.id);

    const stored = getPostgresPool()
      ? (await getPostgresPool().query("SELECT token_hash FROM workspace_shares WHERE id=$1", [share.id])).rows[0]
      : getDatabase().prepare("SELECT token_hash FROM workspace_shares WHERE id=?").get(share.id);
    assert.notEqual(stored.token_hash, share.token);
    assert.equal(stored.token_hash, crypto.createHash("sha256").update(share.token).digest("hex"));

    assert.equal(await revokeWorkspaceShare(ownerUserId, share.id), true);
    assert.equal(await resolveWorkspaceShare(share.token), null);
    assert.equal(await revokeWorkspaceShare(ownerUserId, share.id), false);
  } finally {
    if (getPostgresPool()) {
      await getPostgresPool().query("DELETE FROM workspace_shares WHERE id=$1", [share.id]);
    } else {
      getDatabase().prepare("DELETE FROM workspace_shares WHERE id=?").run(share.id);
    }
  }
});

test("workspace collaboration links reject invalid permissions and expiries", async () => {
  await assert.rejects(
    createWorkspaceShare({ ownerUserId: "test", workspaceId: "default", permission: "admin" }),
    /Permission must be view or edit/
  );
  await assert.rejects(
    createWorkspaceShare({ ownerUserId: "test", workspaceId: "default", permission: "view", expiresInHours: 721 }),
    /expiry must be between/
  );
});
