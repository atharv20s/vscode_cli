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
