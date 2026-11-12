import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../config/env.js";
import { WorkspaceService } from "./workspaceService.js";

test("shared workspace writers use optimistic versions and reject stale saves", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ath-ide-workspace-"));
  const workspaceRoot = path.join(root, "workspace");
  const lockRoot = path.join(root, ".locks");
  await fs.mkdir(workspaceRoot, { recursive: true });

  const firstService = new WorkspaceService(workspaceRoot, "owner-a", {
    watch: false, quotaRoot: root, lockRoot,
  });
  const secondService = new WorkspaceService(workspaceRoot, "owner-a", {
    watch: false, quotaRoot: root, lockRoot,
  });

  try {
    const initial = await firstService.writeFile("src/main.js", "const value = 1;");
    assert.match(initial.version, /^[a-f0-9]{64}$/);

    const read = await secondService.readFile("src/main.js");
    assert.equal(read.version, initial.version);

    const attempts = await Promise.allSettled([
      firstService.writeFile("src/main.js", "const value = 2;", { expectedVersion: initial.version }),
      secondService.writeFile("src/main.js", "const value = 3;", { expectedVersion: initial.version }),
    ]);

    assert.equal(attempts.filter(item => item.status === "fulfilled").length, 1);
    const rejected = attempts.find(item => item.status === "rejected");
    assert.equal(rejected?.reason?.code, "WORKSPACE_VERSION_CONFLICT");

    const latest = await firstService.readFile("src/main.js");
    assert.notEqual(latest.version, initial.version);
    assert.ok(["const value = 2;", "const value = 3;"].includes(latest.content));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("workspace quota and symlink boundaries fail closed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ath-ide-workspace-"));
  const workspaceRoot = path.join(root, "workspace");
  const lockRoot = path.join(root, ".locks");
  const outside = path.join(root, "outside.txt");
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.writeFile(outside, "outside");
  await fs.symlink(outside, path.join(workspaceRoot, "escape.txt"));

  const service = new WorkspaceService(workspaceRoot, "owner-b", {
    watch: false, quotaRoot: root, lockRoot,
  });
  const previousQuota = config.workspaceQuotaBytes;
  try {
    await assert.rejects(
      service.readFile("escape.txt"),
      error => error.message.includes("Access denied")
    );

    config.workspaceQuotaBytes = 10 * 1024 * 1024;
    await service.writeFile("small.txt", "small");
    config.workspaceQuotaBytes = 10 * 1024 * 1024;
  } finally {
    config.workspaceQuotaBytes = previousQuota;
    await fs.rm(root, { recursive: true, force: true });
  }
});
