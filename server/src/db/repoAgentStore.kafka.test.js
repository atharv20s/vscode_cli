import test from "node:test";
import assert from "node:assert/strict";
import { setPostgresPool } from "../db/postgres.js";
import { createRepoTask } from "./repoAgentStore.js";

test("repo-agent task row and Kafka outbox event commit in one PostgreSQL transaction", async () => {
  const calls = [];
  const client = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.includes("INSERT INTO repo_agent_tasks")) {
        return { rows: [{ id: params[0], status: "queued" }] };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => calls.push({ sql: "RELEASE" }),
  };
  setPostgresPool({ connect: async () => client });

  try {
    const task = await createRepoTask({
      id: "task-kafka-outbox-test",
      userId: "user-kafka-outbox-test",
      owner: "example-owner",
      repo: "example-repo",
      baseBranch: "main",
      baseSha: "a".repeat(40),
      branch: "ath/feature",
      prompt: "Add a test feature",
    });

    assert.equal(task.id, "task-kafka-outbox-test");
    assert.equal(calls[0].sql, "BEGIN");
    assert.match(calls[1].sql, /INSERT INTO repo_agent_tasks/);
    assert.match(calls[2].sql, /INSERT INTO kafka_outbox/);
    assert.equal(calls[2].params[0], "repo-task-created:task-kafka-outbox-test");
    assert.equal(calls[3].sql, "COMMIT");
    assert.equal(calls[4].sql, "RELEASE");
  } finally {
    setPostgresPool(null);
  }
});
