#!/usr/bin/env node
/**
 * Live S3-compatible workspace snapshot acceptance check.
 * Run on the execution-worker host with its object-store environment.
 * Writes one small, uniquely keyed test snapshot and verifies its checksum on read.
 */
import crypto from "node:crypto";
import {
  getWorkspaceSnapshot,
  isWorkspaceObjectStoreConfigured,
  putWorkspaceSnapshot,
} from "../server/src/services/workspaceObjectStore.js";

if (!isWorkspaceObjectStoreConfigured()) {
  throw new Error("Workspace object storage is not configured; set the WORKSPACE_OBJECT_STORE_* environment.");
}

const workspaceId = crypto.randomBytes(32).toString("hex");
const marker = "ATH-IDE-S3-RESTORE-ACCEPTANCE:" + crypto.randomUUID();
const snapshot = {
  version: 1,
  updatedAt: new Date().toISOString(),
  files: [{
    path: ".ath-acceptance/s3-roundtrip.txt",
    content: Buffer.from(marker, "utf8").toString("base64"),
  }],
};

await putWorkspaceSnapshot(workspaceId, snapshot);
const restored = await getWorkspaceSnapshot(workspaceId);
const restoredContent = Buffer.from(restored?.files?.[0]?.content || "", "base64").toString("utf8");

if (restoredContent !== marker || restored?.integrity?.algorithm !== "sha256") {
  throw new Error("S3 snapshot read-back did not match the uploaded marker and integrity metadata.");
}

console.log(JSON.stringify({
  success: true,
  operation: "s3-snapshot-upload-readback",
  workspaceId,
  restoredFiles: restored.files.length,
  integrity: restored.integrity.algorithm,
  note: "This verifies object upload/read and checksum validation. It does not replace deleting a disposable worker directory and exercising the worker restore endpoint.",
}, null, 2));
