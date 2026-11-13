import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  initDatabase,
  findUserById,
  findUserByUsername,
  findUserByEmail,
  createUser,
  updateUserToken,
  updateUserProfile,
  createSession,
  touchSession,
  findOrCreateUserSession,
  createConversation,
  getConversation,
  getConversationForUser,
  updateConversationTitle,
  updateConversationMessages,
  listConversations,
  deleteConversation,
  setCacheEntry,
  getCacheEntry,
  getDatabaseHealth,
  closeDatabase,
} from "./database.js";
import { loadMigrationFiles } from "./migrator.js";
import { validateConfig, config } from "../config/env.js";

test("database repository operations work smoothly across users, sessions, and conversations", async (t) => {
  const db = initDatabase();
  if (!db) {
    t.skip("better-sqlite3 native bindings not installed in this environment; skipping SQLite repository tests");
    return;
  }

  const testUserId = "usr_test_" + Date.now();
  const testUsername = "tester_" + Date.now().toString().slice(-6);
  const testEmail = `${testUsername}@example.com`;

  // 1. Create user
  await createUser({
    id: testUserId,
    username: testUsername,
    email: testEmail,
    passwordHash: "salt:hash123",
  });

  // 2. Lookups
  const byId = await findUserById(testUserId);
  assert.equal(byId?.id, testUserId);
  assert.equal(byId?.username, testUsername);

  const byUsername = await findUserByUsername(testUsername.toUpperCase());
  assert.equal(byUsername?.id, testUserId);

  const byEmail = await findUserByEmail(testEmail.toUpperCase());
  assert.equal(byEmail?.id, testUserId);

  // 3. Update token and profile
  await updateUserToken(testUserId, "ghp_mock_token_123");
  const withToken = await findUserById(testUserId);
  assert.equal(withToken.github_access_token, "ghp_mock_token_123");

  await updateUserProfile(testUserId, { avatarUrl: "https://example.com/avatar.png" });
  const withAvatar = await findUserById(testUserId);
  assert.equal(withAvatar.avatar_url, "https://example.com/avatar.png");

  // 4. Session operations
  const testSessionId = "sess_test_" + Date.now();
  await createSession({
    id: testSessionId,
    userId: testUserId,
    workspacePath: "/tmp/test-ws",
  });
  await touchSession(testSessionId);

  // 5. Conversation operations
  const testConvId = "conv_test_" + Date.now();
  await createConversation({
    id: testConvId,
    sessionId: testSessionId,
    userId: testUserId,
    title: "Test Chat Title",
    model: "mock-gpt",
  });

  const conv = await getConversation(testConvId);
  assert.equal(conv?.id, testConvId);
  assert.equal(conv?.title, "Test Chat Title");

  const convUser = await getConversationForUser(testConvId, testUserId);
  assert.equal(convUser?.id, testConvId);

  // Update messages and title
  const messages = [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }];
  await updateConversationMessages(testConvId, messages, 42);
  await updateConversationTitle(testConvId, "Updated Title", testUserId);

  const updatedConv = await getConversation(testConvId);
  assert.equal(updatedConv.title, "Updated Title");

  const convList = await listConversations(testUserId);
  assert.ok(convList.some(c => c.id === testConvId));

  // Delete conversation
  const delRes = await deleteConversation(testConvId, testUserId);
  assert.ok(delRes.changes > 0);
  const deletedConv = await getConversation(testConvId);
  assert.equal(deletedConv, null);

  // 6. Cache operations
  const cacheKey = "test_cache_" + Date.now();
  await setCacheEntry(cacheKey, { foo: "bar" }, 60);
  const cached = await getCacheEntry(cacheKey);
  assert.deepEqual(cached, { foo: "bar" });

  // 7. Health check
  const health = await getDatabaseHealth();
  assert.equal(health.connected, true);
  assert.ok(["postgres", "sqlite"].includes(health.dialect));
});

test("schema migrations are ordered, numbered, and load properly", async () => {
  const migrations = await loadMigrationFiles();
  assert.ok(migrations.length >= 1, "At least one migration file should exist");
  assert.equal(migrations[0].version, 1);
  assert.ok(migrations[0].name.includes("initial_schema"));
});

test("PostgreSQL repository adapter routes queries and formats JSONB properly", async () => {
  const executed = [];
  const mockPool = {
    query: async (sql, params) => {
      executed.push({ sql, params });
      if (sql.includes("SELECT * FROM users WHERE id = $1")) {
        return { rows: [{ id: params[0], username: "pg_user", email: "pg@example.com" }] };
      }
      if (sql.includes("SELECT * FROM conversations WHERE id = $1")) {
        return { rows: [{ id: params[0], title: "PG Conv", messages: JSON.stringify([{ role: "user", content: "hi" }]) }] };
      }
      if (sql.includes("SELECT COALESCE(MAX(version), 0)")) {
        return { rows: [{ max_ver: "1" }] };
      }
      if (sql.includes("SELECT CURRENT_TIMESTAMP")) {
        return { rows: [{ now: new Date().toISOString() }] };
      }
      return { rows: [], rowCount: 1 };
    },
    connect: async () => ({
      query: async (sql, params) => mockPool.query(sql, params),
      release: () => {},
    }),
    totalCount: 5,
    idleCount: 3,
    waitingCount: 0,
  };

  // We can test database functions with mock pool injected into postgres.js
  const pgModule = await import("./postgres.js");
  const origPool = pgModule.getPostgresPool();

  try {
    pgModule.setPostgresPool(mockPool);

    // 1. User lookup via Postgres
    const userRes = await findUserById("usr_pg_test_999");
    assert.equal(userRes?.id, "usr_pg_test_999");
    assert.equal(userRes?.username, "pg_user");

    // 2. User creation via Postgres
    await createUser({
      id: "usr_new_123",
      username: "alice",
      email: "alice@test.com",
    });
    assert.ok(executed.some(e => e.sql.includes("INSERT INTO users")));

    // 3. Conversation via Postgres
    const conv = await getConversation("conv_pg_1");
    assert.equal(conv?.title, "PG Conv");
    assert.deepEqual(conv?.messages, [{ role: "user", content: "hi" }]);

    // 4. Health check
    const health = await getDatabaseHealth();
    assert.equal(health.ok, true);
    assert.equal(health.dialect, "postgres");
    assert.equal(health.schemaVersion, 1);
  } finally {
    pgModule.setPostgresPool(origPool);
  }
});

test("production fail-closed configuration rejects startup without DATABASE_URL in production", () => {
  const originalEnv = process.env.NODE_ENV;
  const originalDb = process.env.DATABASE_URL;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.DATABASE_URL;
    config.isDev = false;
    config.databaseUrl = "";

    const { errors } = validateConfig();
    assert.ok(
      errors.some(e => e.includes("DATABASE_URL is required in production")),
      "Validation should produce error when DATABASE_URL is missing in production"
    );
  } finally {
    process.env.NODE_ENV = originalEnv;
    if (originalDb !== undefined) process.env.DATABASE_URL = originalDb;
    config.isDev = (originalEnv || "development") === "development";
    config.databaseUrl = originalDb || "";
  }
});
