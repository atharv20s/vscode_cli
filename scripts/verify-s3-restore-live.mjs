#!/usr/bin/env node
/**
 * End-to-end S3 workspace restore drill.
 *
 * Run ON the execution-worker host. This creates a unique workspace through
 * the authenticated worker sync API (which persists its S3 snapshot), removes
 * only that exact disposable workspace directory, then calls the real worker
 * pull endpoint and verifies the marker was restored from object storage.
 *
 * The unique S3 object is intentionally retained for audit/debugging. It is
 * small and isolated under its random 256-bit workspace key.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../server/src/config/env.js";
import { isWorkspaceObjectStoreConfigured } from "../server/src/services/workspaceObjectStore.js";

const secret = process.env.WORKER_SHARED_SECRET || "";
const workerUrl = new URL(process.env.WORKER_LOCAL_URL || "http://127.0.0.1:8081");
if (!["127.0.0.1", "::1", "localhost"].includes(workerUrl.hostname)) {
  throw new Error("WORKER_LOCAL_URL must point to localhost; this drill sends the worker HMAC secret.");
}
if (!["http:", "https:"].includes(workerUrl.protocol)) throw new Error("WORKER_LOCAL_URL must use HTTP or HTTPS.");
if (secret.length < 32) throw new Error("WORKER_SHARED_SECRET must be loaded from the execution-worker environment.");
if (!isWorkspaceObjectStoreConfigured()) throw new Error("S3-compatible workspace object storage is not configured.");

const workspaceId = crypto.randomBytes(32).toString("hex");
const marker = "ATH_IDE_S3_RESTORE_" + crypto.randomUUID();
const relativePath = "acceptance/restore-marker.txt";
const root = path.join(config.workspaceRoot, "remote-users", workspaceId);
const remoteUsersRoot = path.dirname(root);

async function signedPost(route, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const signature = crypto.createHmac("sha256", secret)
    .update(timestamp).update(".").update(nonce).update(".")
    .update("POST").update(".").update(route).update(".")
    .update(body).digest("hex");
  const response = await fetch(new URL(route, workerUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-worker-timestamp": timestamp,
      "x-worker-nonce": nonce,
      "x-worker-signature": signature,
    },
    body,
    signal: AbortSignal.timeout(60000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("Worker " + route + " returned HTTP " + response.status + ": " + (result.error || "unknown error"));
  return result;
}

function assertInsideWorkerRoot(candidate) {
  const relative = path.relative(path.resolve(config.workspaceRoot), path.resolve(candidate));
  if (!relative.startsWith("remote-users" + path.sep) ||
      relative.split(path.sep).length !== 2 ||
      relative.split(path.sep)[1] !== workspaceId) {
    throw new Error("Refusing to remove a path outside the exact disposable workspace.");
  }
}

let restored = false;
try {
  assertInsideWorkerRoot(root);
  await fs.mkdir(remoteUsersRoot, { recursive: true, mode: 0o700 });
  const parentStat = await fs.lstat(remoteUsersRoot);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("Worker remote-users root is not a real directory; refusing destructive test.");
  }
  const parentReal = await fs.realpath(remoteUsersRoot);
  if (parentReal !== path.resolve(remoteUsersRoot)) {
    throw new Error("Worker remote-users root resolves through a symlink; refusing destructive test.");
  }

  const sync = await signedPost("/v1/workspace/sync", {
    workspaceId,
    files: [{ path: relativePath, content: Buffer.from(marker).toString("base64") }],
  });
  if (!sync.success || sync.syncedFiles !== 1) throw new Error("Worker did not persist the disposable workspace snapshot.");

  const before = await fs.readFile(path.join(root, relativePath), "utf8");
  if (before !== marker) throw new Error("Pre-delete workspace marker did not match.");

  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Disposable workspace root is not a real directory; refusing removal.");
  }
  await fs.rm(root, { recursive: true, force: false });
  try {
    await fs.access(root);
    throw new Error("Workspace directory still exists after deletion.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const pull = await signedPost("/v1/workspace/pull", { workspaceId });
  const returned = pull.files?.find(file => file.path === relativePath);
  const returnedMarker = returned ? Buffer.from(returned.content, "base64").toString("utf8") : "";
  const diskMarker = await fs.readFile(path.join(root, relativePath), "utf8");
  if (returnedMarker !== marker || diskMarker !== marker) {
    throw new Error("Worker pull did not restore the original marker from the S3 snapshot.");
  }
  restored = true;
  console.log(JSON.stringify({
    success: true,
    test: "s3-workspace-delete-and-worker-restore",
    workspaceId,
    deletedBeforeRestore: true,
    restoredThroughWorkerPullEndpoint: true,
    markerVerifiedInResponse: true,
    markerVerifiedOnDisk: true,
    snapshotIntegrity: "validated by worker object-store restore",
    retainedSnapshotForAudit: true,
  }, null, 2));
} finally {
  // Remove only this random disposable local workspace. Preserve the S3 object
  // as a small audit artifact; it can be lifecycle-expired by bucket policy.
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  if (!restored) {
    console.error(JSON.stringify({ success: false, workspaceId, cleanup: "local disposable workspace removed" }));
  }
}
