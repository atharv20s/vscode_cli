import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config/env.js";
import { createAgentRunSnapshot, completeAgentRunSnapshot, rollbackAgentRunSnapshot } from "./agentRunSnapshotService.js";

async function fixture() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "ath-agent-snapshot-"));
  const root = path.join(parent, "workspace");
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "a.js"), "before");
  await fs.writeFile(path.join(root, ".git", "index"), "index-before");
  const workspaceId = "workspace-test";
  const identity = crypto.createHash("sha256").update(workspaceId + "\\0" + path.resolve(root)).digest("hex").slice(0, 32);
  return { parent, root, identity, workspace: { workspaceId, workspaceRoot: root } };
}

test("restores workspace files, untracked files, Git index and editor state", async () => {
  const f = await fixture();
  try {
    const snapshot = await createAgentRunSnapshot(f.workspace, { activeTab: "src/a.js", activeGroup: "secondary", groupTabs: { primary: "src/a.js", secondary: "src/a.js" }, splitRatio: 0.62, tabs: [{ path: "src/a.js", content: "dirty editor buffer", isDirty: true }] });
    await fs.writeFile(path.join(f.root, "src", "a.js"), "after");
    await fs.writeFile(path.join(f.root, "new.txt"), "untracked");
    await fs.writeFile(path.join(f.root, ".git", "index"), "index-after");
    await completeAgentRunSnapshot(f.workspace, snapshot.runId);
    const result = await rollbackAgentRunSnapshot(f.workspace, snapshot.runId);
    assert.equal(await fs.readFile(path.join(f.root, "src", "a.js"), "utf8"), "before");
    await assert.rejects(fs.access(path.join(f.root, "new.txt")));
    assert.equal(await fs.readFile(path.join(f.root, ".git", "index"), "utf8"), "index-before");
    assert.equal(result.editorState.tabs[0].content, "dirty editor buffer");
    assert.equal(result.editorState.groupTabs.secondary, "src/a.js");
    assert.equal(result.editorState.splitRatio, 0.62);
  } finally { await fs.rm(f.parent, { recursive: true, force: true }); await fs.rm(path.join(config.workspaceRoot, ".ath-agent-run-snapshots", f.identity), { recursive: true, force: true }); }
});

test("refuses rollback when workspace changes after run completion", async () => {
  const f = await fixture();
  try {
    const snapshot = await createAgentRunSnapshot(f.workspace);
    await fs.writeFile(path.join(f.root, "src", "a.js"), "agent");
    await completeAgentRunSnapshot(f.workspace, snapshot.runId);
    await fs.writeFile(path.join(f.root, "src", "a.js"), "user edit after agent");
    await assert.rejects(rollbackAgentRunSnapshot(f.workspace, snapshot.runId), error => error.code === "SNAPSHOT_ROLLBACK_CONFLICT");
  } finally { await fs.rm(f.parent, { recursive: true, force: true }); }
});

test("requires a completed snapshot before rollback", async () => {
  const f = await fixture();
  try {
    const snapshot = await createAgentRunSnapshot(f.workspace);
    await assert.rejects(rollbackAgentRunSnapshot(f.workspace, snapshot.runId), error => error.code === "SNAPSHOT_NOT_COMPLETED");
  } finally { await fs.rm(f.parent, { recursive: true, force: true }); }
});
