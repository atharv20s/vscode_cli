import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptSnapshot, decryptSnapshot, deriveSnapshotKey } from "./workspaceSnapshotEncryption.js";

const SECRET = "my-super-secure-master-passphrase-32bytes";

test("encrypts and decrypts snapshot data reversibly", () => {
  const original = JSON.stringify({
    files: [{ path: "src/index.ts", content: "console.log('hello');" }],
    gitHead: "a1b2c3d4",
  });

  const { payload, digest, algorithm } = encryptSnapshot(original, SECRET);
  assert.equal(algorithm, "aes-256-gcm");
  assert.ok(payload.length > original.length);
  assert.ok(digest && digest.length === 64);

  const decrypted = decryptSnapshot(payload, SECRET);
  assert.equal(decrypted.toString("utf8"), original);
});

test("rejects tampered ciphertext with an authentication error", () => {
  const original = "sensitive source code payload";
  const { payload } = encryptSnapshot(original, SECRET);

  // Tamper with the last byte
  payload[payload.length - 1] ^= 0xff;

  assert.throws(() => {
    decryptSnapshot(payload, SECRET);
  }, /Snapshot decryption failed.*tampered payload/);
});

test("rejects decryption with an incorrect secret key", () => {
  const original = "important customer project";
  const { payload } = encryptSnapshot(original, SECRET);

  assert.throws(() => {
    decryptSnapshot(payload, "different-wrong-secret-passphrase");
  }, /Snapshot decryption failed/);
});

test("deriveSnapshotKey generates a 32-byte key buffer using HKDF", () => {
  const key1 = deriveSnapshotKey(SECRET);
  const key2 = deriveSnapshotKey(SECRET);
  assert.equal(key1.length, 32);
  assert.ok(key1.equals(key2));
});
