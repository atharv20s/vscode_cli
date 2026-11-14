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
    "WORKSPACE_OBJECT_STORE_SESSION_TOKEN",
    "WORKSPACE_OBJECT_STORE_SERVER_SIDE_ENCRYPTION",
    "WORKSPACE_OBJECT_STORE_KMS_KEY_ID",
  ];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  const calls = [];
  const snapshot = { version: 1, updatedAt: new Date().toISOString(), files: [{ path: "src/app.js", content: Buffer.from("ok").toString("base64") }] };
  let stored = null;
  try {
    process.env.WORKSPACE_OBJECT_STORE_BUCKET = "ath-workspaces";
    process.env.WORKSPACE_OBJECT_STORE_ACCESS_KEY_ID = "test-access";
    process.env.WORKSPACE_OBJECT_STORE_SECRET_ACCESS_KEY = "test-secret";
    process.env.WORKSPACE_OBJECT_STORE_REGION = "us-east-1";
    process.env.WORKSPACE_OBJECT_STORE_ENDPOINT = "https://objects.example.test";
    process.env.WORKSPACE_OBJECT_STORE_SESSION_TOKEN = "test-session-token";
    process.env.WORKSPACE_OBJECT_STORE_SERVER_SIDE_ENCRYPTION = "aws:kms";
    process.env.WORKSPACE_OBJECT_STORE_KMS_KEY_ID = "arn:aws:kms:us-east-1:123456789012:key/test";
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      if (options.method === "PUT") {
        stored = JSON.parse(Buffer.from(options.body).toString("utf8"));
        return new Response("", { status: 200 });
      }
      return Response.json(stored, { status: 200 });
    };

    assert.equal(isWorkspaceObjectStoreConfigured(), true);
    assert.equal(await putWorkspaceSnapshot("a".repeat(64), snapshot), true);
    const restored = await getWorkspaceSnapshot("a".repeat(64));
    assert.deepEqual(restored.files, snapshot.files);
    assert.equal(restored.integrity.algorithm, "sha256");
    assert.equal(calls.length, 2);

    stored.files[0].content = Buffer.from("tampered").toString("base64");
    await assert.rejects(
      getWorkspaceSnapshot("a".repeat(64)),
      /integrity check failed/
    );
    assert.match(calls[0].options.headers.authorization, /^AWS4-HMAC-SHA256 /);
    assert.equal(calls[0].options.headers["x-amz-security-token"], "test-session-token");
    assert.equal(calls[0].options.headers["x-amz-server-side-encryption"], "aws:kms");
    assert.equal(calls[0].options.headers["x-amz-server-side-encryption-aws-kms-key-id"], "arn:aws:kms:us-east-1:123456789012:key/test");
    assert.match(calls[0].options.headers.authorization, /SignedHeaders=[^,]*x-amz-security-token/);
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


test("workspace object storage rejects unsafe identities and snapshot paths", async () => {
  const names = [
    "WORKSPACE_OBJECT_STORE_BUCKET",
    "WORKSPACE_OBJECT_STORE_ACCESS_KEY_ID",
    "WORKSPACE_OBJECT_STORE_SECRET_ACCESS_KEY",
  ];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.WORKSPACE_OBJECT_STORE_BUCKET = "ath-workspaces";
    process.env.WORKSPACE_OBJECT_STORE_ACCESS_KEY_ID = "test-access";
    process.env.WORKSPACE_OBJECT_STORE_SECRET_ACCESS_KEY = "test-secret";
    await assert.rejects(
      putWorkspaceSnapshot("../outside", { version: 1, files: [] }),
      /Invalid workspace identity/
    );
    await assert.rejects(
      putWorkspaceSnapshot("b".repeat(64), { version: 1, files: [{ path: "../outside", content: "b2s=" }] }),
      /unsafe file entry/
    );
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
