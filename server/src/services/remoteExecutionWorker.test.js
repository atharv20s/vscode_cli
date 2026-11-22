import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyWorkspaceFiles,
  collectWorkspaceFiles,
} from "./remoteExecutionWorker.js";

async function withWorkspace(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ath-workspace-sync-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const encoded = value => Buffer.from(value, "utf8").toString("base64");

test("collectWorkspaceFiles returns regular files and excludes ignored directories", async () => {
  await withWorkspace(async root => {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules", "dep"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "index.js"), "export const answer = 42;");
    await fs.writeFile(path.join(root, "node_modules", "dep", "index.js"), "ignored");
    const files = await collectWorkspaceFiles(root);
    assert.deepEqual(files.map(file => file.path), ["src/index.js"]);
    assert.equal(Buffer.from(files[0].content, "base64").toString("utf8"), "export const answer = 42;");
  });
});

test("applyWorkspaceFiles writes the snapshot and removes files absent from it", async () => {
  await withWorkspace(async root => {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "old.js"), "old");
    await fs.writeFile(path.join(root, "README.md"), "unchanged");
    await applyWorkspaceFiles(root, [
      { path: "src/new.js", content: encoded("new") },
      { path: "README.md", content: encoded("unchanged") },
    ]);
    assert.equal(await fs.readFile(path.join(root, "src", "new.js"), "utf8"), "new");
    assert.equal(await fs.readFile(path.join(root, "README.md"), "utf8"), "unchanged");
    await assert.rejects(fs.access(path.join(root, "src", "old.js")), { code: "ENOENT" });
  });
});

test("applyWorkspaceFiles validates the complete snapshot before mutating local files", async () => {
  await withWorkspace(async root => {
    await fs.writeFile(path.join(root, "keep.txt"), "original");
    await assert.rejects(
      applyWorkspaceFiles(root, [
        { path: "keep.txt", content: encoded("replacement") },
        { path: "../escape.txt", content: encoded("outside") },
      ]),
      /unsafe file path/i,
    );
    assert.equal(await fs.readFile(path.join(root, "keep.txt"), "utf8"), "original");
    await assert.rejects(fs.access(path.join(path.dirname(root), "escape.txt")), { code: "ENOENT" });
  });
});

test("applyWorkspaceFiles rejects non-canonical base64 before mutation", async () => {
  await withWorkspace(async root => {
    await fs.writeFile(path.join(root, "keep.txt"), "original");
    await assert.rejects(
      applyWorkspaceFiles(root, [{ path: "keep.txt", content: "not base64!" }]),
      /invalid file/i,
    );
    assert.equal(await fs.readFile(path.join(root, "keep.txt"), "utf8"), "original");
  });
});

test("workspace snapshot application refuses symlink traversal", async () => {
  await withWorkspace(async root => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "ath-workspace-outside-"));
    try {
      await fs.writeFile(path.join(outside, "secret.txt"), "outside");
      await fs.symlink(outside, path.join(root, "linked"), "dir");
      await assert.rejects(
        applyWorkspaceFiles(root, [{ path: "linked/secret.txt", content: encoded("overwritten") }]),
        /symbolic links/i,
      );
      assert.equal(await fs.readFile(path.join(outside, "secret.txt"), "utf8"), "outside");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test("applyWorkspaceFiles preserves files created locally during in-flight remote operations", async () => {
  await withWorkspace(async root => {
    // Initial file sent to worker
    await fs.writeFile(path.join(root, "initial.txt"), "initial-content");
    const baselineFiles = [{ path: "initial.txt", content: encoded("initial-content") }];

    // User creates a new file locally while worker is running
    await fs.writeFile(path.join(root, "concurrent-local.txt"), "user-typed-this");

    // Worker returns snapshot (which only knows about initial.txt and modified it)
    await applyWorkspaceFiles(root, [
      { path: "initial.txt", content: encoded("initial-updated-by-worker") },
    ], { baselineFiles });

    // Both the worker updated file and the newly created local file must exist
    assert.equal(await fs.readFile(path.join(root, "initial.txt"), "utf8"), "initial-updated-by-worker");
    assert.equal(await fs.readFile(path.join(root, "concurrent-local.txt"), "utf8"), "user-typed-this");
  });
});

test("applyWorkspaceFiles preserves local edits when concurrent conflict occurs", async () => {
  await withWorkspace(async root => {
    // Initial file sent to worker
    await fs.writeFile(path.join(root, "conflict.txt"), "version-1");
    const baselineFiles = [{ path: "conflict.txt", content: encoded("version-1") }];

    // User modified conflict.txt locally while worker ran
    await fs.writeFile(path.join(root, "conflict.txt"), "version-1-local-edit");

    // Worker returns a different version-2
    await applyWorkspaceFiles(root, [
      { path: "conflict.txt", content: encoded("version-2-remote") },
    ], { baselineFiles });

    // Local edit must be preserved over stale/conflicting remote snapshot
    assert.equal(await fs.readFile(path.join(root, "conflict.txt"), "utf8"), "version-1-local-edit");
  });
});
