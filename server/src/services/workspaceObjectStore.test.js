import test from "node:test";
import assert from "node:assert/strict";
import {
  getWorkspaceSnapshot,
  isWorkspaceObjectStoreConfigured,
  putWorkspaceSnapshot,
} from "./workspaceObjectStore.js";

test("S3-compatible workspace snapshots are signed and round-trip through the object API", async () => {
  const names = [
    "WORKSPACE_OBJECT_STORE_BUCKET",
    "WORKSPACE_OBJECT_STORE_ACCESS_KEY_ID",
    "WORKSPACE_OBJECT_STORE_SECRET_ACCESS_KEY",
    "WORKSPACE_OBJECT_STORE_REGION",
    "WORKSPACE_OBJECT_STORE_ENDPOINT",
  ];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  const calls = [];
  const snapshot = { version: 1, updatedAt: new Date().toISOString(), files: [{ path: "src/app.js", content: Buffer.from("ok").toString("base64") }] };
  try {
    process.env.WORKSPACE_OBJECT_STORE_BUCKET = "ath-workspaces";
    process.env.WORKSPACE_OBJECT_STORE_ACCESS_KEY_ID = "test-access";
    process.env.WORKSPACE_OBJECT_STORE_SECRET_ACCESS_KEY = "test-secret";
    process.env.WORKSPACE_OBJECT_STORE_REGION = "us-east-1";
    process.env.WORKSPACE_OBJECT_STORE_ENDPOINT = "https://objects.example.test";
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      if (options.method === "PUT") return new Response("", { status: 200 });
      return Response.json(snapshot, { status: 200 });
    };

    assert.equal(isWorkspaceObjectStoreConfigured(), true);
    assert.equal(await putWorkspaceSnapshot("a".repeat(64), snapshot), true);
    assert.deepEqual(await getWorkspaceSnapshot("a".repeat(64)), snapshot);
    assert.equal(calls.length, 2);
    assert.match(calls[0].options.headers.authorization, /^AWS4-HMAC-SHA256 /);
    assert.equal(calls[0].options.headers["x-amz-content-sha256"].length, 64);
    assert.match(calls[0].url, /ath-workspaces\/workspaces\/a{64}\/snapshot\.json$/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
