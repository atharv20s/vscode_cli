import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  resolveSafeWorkspacePath,
  safeRelativeWorkspacePath,
} from "./workspacePathSafety.js";

test("workspace paths reject traversal and platform-specific separators", () => {
  for (const value of ["../secret", "src/../../secret", "/etc/passwd", "src\\secret", "src//file.js", "src/./file.js", ""]) {
    assert.equal(safeRelativeWorkspacePath(value), false, value);
  }
  assert.equal(safeRelativeWorkspacePath("src/components/App.jsx"), true);
});

test("workspace path resolver rejects symlink files and parent directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ath-path-safe-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "ath-path-outside-"));
  try {
    await fs.mkdir(path.join(root, "real"), { recursive: true });
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    await fs.symlink(outside, path.join(root, "linked-dir"), "dir");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "linked-file"));

    assert.equal(
      await resolveSafeWorkspacePath(root, "real/new-file.txt"),
      path.join(root, "real", "new-file.txt")
    );
    await assert.rejects(resolveSafeWorkspacePath(root, "linked-dir/secret.txt"), /symbolic links/);
    await assert.rejects(resolveSafeWorkspacePath(root, "linked-file"), /symbolic links/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
