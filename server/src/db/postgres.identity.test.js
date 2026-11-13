import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresIdentity } from "./postgres.js";

test("direct and pooled Neon URLs produce the same non-secret database identity", () => {
  const direct = "postgresql://app:secret@ep-orange-123.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=verify-full";
  const pooled = "postgresql://app:secret@ep-orange-123-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=verify-full";
  assert.equal(
    createPostgresIdentity(direct, "neondb", "app"),
    createPostgresIdentity(pooled, "neondb", "app")
  );
  assert.notEqual(
    createPostgresIdentity(direct, "neondb", "app"),
    createPostgresIdentity(direct.replace("ep-orange-123", "ep-blue-456"), "neondb", "app")
  );
  assert.notEqual(
    createPostgresIdentity(direct, "neondb", "app"),
    createPostgresIdentity(direct, "otherdb", "app")
  );
});
