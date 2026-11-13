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
  const first = getWorkspaceService("owner-a-" + suffix, "shared-name");
  const second = getWorkspaceService("owner-b-" + suffix, "shared-name");
  try {
    config.workspaceStorageRoot = root;
    // The services above were created from the prior config, so obtain fresh
    // owner-scoped instances after switching to the test-only storage root.
    const userA = getWorkspaceService("test-owner-a-" + suffix, "shared-name");
    const userB = getWorkspaceService("test-owner-b-" + suffix, "shared-name");
    assert.notEqual(userA.workspaceRoot, userB.workspaceRoot);
    await userA.writeFile("private.txt", "belongs to A");
    await userB.writeFile("private.txt", "belongs to B");
    assert.equal((await userA.readFile("private.txt")).content, "belongs to A");
    assert.equal((await userB.readFile("private.txt")).content, "belongs to B");
    assert.notEqual(userA.ownerKey, userB.ownerKey);
  } finally {
    for (const service of [first, second]) service.watcher?.close();
    const userA = getWorkspaceService("test-owner-a-" + suffix, "shared-name");
    const userB = getWorkspaceService("test-owner-b-" + suffix, "shared-name");
    userA.watcher?.close();
    userB.watcher?.close();
    config.workspaceStorageRoot = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});
