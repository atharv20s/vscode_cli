import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config/env.js";
import { getWorkspaceService } from "./workspaceService.js";

test("authenticated owners receive isolated workspace roots and file contents", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ath-workspace-isolation-"));
  const previousRoot = config.workspaceStorageRoot;
  const suffix = crypto.randomUUID();
  let userA;
  let userB;
  try {
    config.workspaceStorageRoot = root;
    userA = getWorkspaceService("test-owner-a-" + suffix, "shared-name");
    userB = getWorkspaceService("test-owner-b-" + suffix, "shared-name");
    assert.notEqual(userA.workspaceRoot, userB.workspaceRoot);
    await userA.writeFile("private.txt", "belongs to A");
    await userB.writeFile("private.txt", "belongs to B");
    assert.equal((await userA.readFile("private.txt")).content, "belongs to A");
    assert.equal((await userB.readFile("private.txt")).content, "belongs to B");
    assert.notEqual(userA.ownerKey, userB.ownerKey);
  } finally {
    userA?.watcher?.close();
    userB?.watcher?.close();
    config.workspaceStorageRoot = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});
