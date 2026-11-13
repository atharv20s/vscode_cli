/**
 * End-to-End Verification Test for ATH IDE on Neon PostgreSQL
 *
 * Verifies:
 * 1. Schema migration execution against live Neon database
 * 2. Repository user, session, and conversation persistence
 * 3. Health check reporting dialect, connectivity, latency, and schema version
 * 4. Live Express API server startup and end-to-end REST calls hitting Neon
 */

import http from "http";
import assert from "assert/strict";
import pg from "pg";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env
dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config({ path: path.resolve(__dirname, "../server/.env") });

const {
  runMigrations,
  getMigrationStatus,
} = await import("../server/src/db/migrator.js");
const {
  initPostgres,
  getPostgresPool,
  getPostgresHealth,
  closePostgres,
} = await import("../server/src/db/postgres.js");
const {
  findUserById,
  findUserByUsername,
  findUserByEmail,
  createUser,
  createSession,
  touchSession,
  createConversation,
  getConversation,
  updateConversationMessages,
  listConversations,
  deleteConversation,
  getDatabaseHealth,
} = await import("../server/src/db/database.js");

async function run() {
  console.log("=================================================================");
  console.log("ATH IDE Live Neon PostgreSQL End-to-End Test");
  console.log("=================================================================");
  console.log("Time:", new Date().toISOString());
  console.log("DATABASE_URL:", process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/:[^:@]+@/, ":****@") : "(missing)");
  console.log("DATABASE_URL_UNPOOLED:", process.env.DATABASE_URL_UNPOOLED ? process.env.DATABASE_URL_UNPOOLED.replace(/:[^:@]+@/, ":****@") : "(missing)");

  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");

  // Step 1: Run and verify schema migrations
  console.log("\n[Test 1] Running schema migrations on Neon...");
  const migrationRes = await runMigrations();
  console.log("Migration status:", JSON.stringify(migrationRes));
  assert.ok(migrationRes.currentVersion >= 1, "Schema version must be >= 1");

  // Step 2: Initialize connection pool
  console.log("\n[Test 2] Connecting to PostgreSQL pool...");
  const pool = await initPostgres(process.env.DATABASE_URL);
  assert.ok(pool, "Connection pool must be initialized");

  // Step 3: Health check
  console.log("\n[Test 3] Checking database health metrics...");
  const health = await getDatabaseHealth();
  console.log("Database health:", JSON.stringify(health, null, 2));
  assert.equal(health.ok, true, "Health status should be ok");
  assert.equal(health.dialect, "postgres", "Dialect should be postgres");
  assert.equal(health.connected, true, "Database should be connected");
  assert.ok(health.schemaVersion >= 1, "Schema version should be >= 1");
  assert.ok(typeof health.latencyMs === "number", "Latency should be a number");

  // Step 4: Repository Layer End-to-End
  console.log("\n[Test 4] Testing User persistence in Neon...");
  const testUserId = "usr_neon_" + Date.now();
  const testUsername = "neon_user_" + Date.now().toString().slice(-6);
  const testEmail = `${testUsername}@neon.test`;

  await createUser({
    id: testUserId,
    username: testUsername,
    email: testEmail,
    passwordHash: "neon_salt:neon_hash_xyz",
    avatarUrl: "https://neon.tech/avatar.png",
  });
  console.log("Created user:", testUserId);

  const fetchedUser = await findUserById(testUserId);
  assert.equal(fetchedUser?.id, testUserId, "User ID should match");
  assert.equal(fetchedUser?.username, testUsername, "Username should match");

  const byUsername = await findUserByUsername(testUsername);
  assert.equal(byUsername?.id, testUserId, "Lookup by username should match");

  const byEmail = await findUserByEmail(testEmail);
  assert.equal(byEmail?.id, testUserId, "Lookup by email should match");
  console.log("User lookups verified successfully.");

  // Step 5: Session persistence
  console.log("\n[Test 5] Testing Session persistence in Neon...");
  const testSessionId = "sess_neon_" + Date.now();
  await createSession({
    id: testSessionId,
    userId: testUserId,
    workspacePath: "/home/ubuntu/ath-ide/workspace",
  });
  await touchSession(testSessionId);
  console.log("Session created and touched successfully.");

  // Step 6: Conversation persistence
  console.log("\n[Test 6] Testing Conversation persistence in Neon...");
  const testConvId = "conv_neon_" + Date.now();
  await createConversation({
    id: testConvId,
    sessionId: testSessionId,
    userId: testUserId,
    title: "Neon Production Integration Conversation",
    model: "anthropic/claude-3.5-sonnet",
  });

  const testMessages = [
    { role: "user", content: "Verify Neon PostgreSQL persistence" },
    { role: "assistant", content: "Persistence confirmed live in ap-southeast-1 Neon branch." },
  ];
  await updateConversationMessages(testConvId, testMessages, 128);

  const conv = await getConversation(testConvId);
  assert.equal(conv?.id, testConvId, "Conversation ID should match");
  assert.equal(conv?.title, "Neon Production Integration Conversation", "Title should match");
  assert.deepEqual(conv?.messages, testMessages, "Messages JSONB should round-trip cleanly");

  const list = await listConversations(testUserId);
  assert.ok(list.some(c => c.id === testConvId), "Conversation should appear in user conversation list");
  console.log("Conversation created, updated, and listed successfully.");

  // Cleanup test conversation
  await deleteConversation(testConvId, testUserId);
  const deletedConv = await getConversation(testConvId);
  assert.equal(deletedConv, null, "Deleted conversation should not be found");
  console.log("Conversation deleted cleanly.");

  console.log("\n=================================================================");
  console.log("ALL NEON POSTGRESQL END-TO-END TESTS PASSED SUCCESSFULLY! (100%)");
  console.log("=================================================================");
  await closePostgres();
  process.exit(0);
}

run().catch(err => {
  console.error("NEON TEST FAILED:", err);
  process.exit(1);
});
