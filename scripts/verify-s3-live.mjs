import { putWorkspaceSnapshot, getWorkspaceSnapshot, isWorkspaceObjectStoreConfigured } from "/home/ubuntu/ath-ide/server/src/services/workspaceObjectStore.js";

console.log("Configured:", isWorkspaceObjectStoreConfigured());

const workspaceId = "c6899a5c1950473e93159cc9b571bfb521e2453e809f7a003dba6ffd3a9e13b4";
const snapshot = {
  version: 1,
  timestamp: Date.now(),
  files: [{ path: "README.md", content: "# Hello from ATH IDE Live S3 Snapshot", encoding: "utf8" }],
};

console.log("1. Uploading snapshot to S3...");
const upload = await putWorkspaceSnapshot(workspaceId, snapshot);
console.log("   Upload result:", upload);

console.log("2. Restoring snapshot from S3...");
const restored = await getWorkspaceSnapshot(workspaceId);
console.log("   Restored file count:", restored.files.length);
console.log("   Restored file path:", restored.files[0].path);
console.log("   Restored file content:", restored.files[0].content);

