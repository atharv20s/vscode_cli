import crypto from "crypto";
import { config } from "../config/env.js";
import { getDatabase } from "../db/database.js";
import { getPostgresPool } from "../db/postgres.js";

const RESERVE_FACTOR = 1.2;
const utcDate = () => new Date().toISOString().slice(0, 10);

function getPricing(provider, model) {
  const pricing = config.llmModelPricing?.[provider]?.[model] || config.llmModelPricing?.[provider + ":" + model];
  if (!pricing || typeof pricing !== "object") return null;
  const inputPer1kUsd = Number(pricing.inputPer1kUsd);
  const outputPer1kUsd = Number(pricing.outputPer1kUsd);
  if (!Number.isFinite(inputPer1kUsd) || !Number.isFinite(outputPer1kUsd) || inputPer1kUsd < 0 || outputPer1kUsd < 0) return null;
  return { inputPer1kUsd, outputPer1kUsd };
}
function tokenEstimate(messages) {
  return Math.max(1, Math.ceil(JSON.stringify(messages || []).length / 3.5));
}
function estimateCost(inputTokens, outputTokens, pricing) {
  return inputTokens / 1000 * pricing.inputPer1kUsd + outputTokens / 1000 * pricing.outputPer1kUsd;
}
function budgetError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function reserveLlmBudget({ userId, provider, model, messages, maxOutputTokens }) {
  if (!config.llmDailyBudgetUsd || config.llmDailyBudgetUsd <= 0) return null;
  if (!userId) throw budgetError("LLM_BUDGET_USER_REQUIRED", "A user identity is required when the daily LLM budget is enabled.");
  const pricing = getPricing(provider, model);
  if (!pricing) {
    throw budgetError("LLM_PRICE_NOT_CONFIGURED", "No exact token pricing is configured for " + provider + "/" + model + ". Add current inputPer1kUsd and outputPer1kUsd values before using the daily budget gate.");
  }

  const inputTokens = tokenEstimate(messages);
  const outputTokens = Math.max(1, Number(maxOutputTokens) || 1);
  const reservedUsd = estimateCost(inputTokens, outputTokens, pricing) * RESERVE_FACTOR;
  const usageDate = utcDate();
  const id = crypto.randomUUID();
  const budget = config.llmDailyBudgetUsd;
  const pool = getPostgresPool();

  if (config.databaseUrl && !pool) {
    throw budgetError("LLM_BUDGET_LEDGER_UNAVAILABLE", "The shared PostgreSQL usage ledger is not ready. Model requests are blocked until the spend ledger is available.");
  }

  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO llm_daily_usage (user_id, usage_date) VALUES ($1, $2) ON CONFLICT (user_id, usage_date) DO NOTHING",
        [userId, usageDate]
      );
      const updated = await client.query(
        `UPDATE llm_daily_usage
         SET reserved_usd = reserved_usd + $3, request_count = request_count + 1, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND usage_date = $2 AND spent_usd + reserved_usd + $3 <= $4
         RETURNING spent_usd, reserved_usd`,
        [userId, usageDate, reservedUsd, budget]
      );
      if (!updated.rowCount) {
        const row = await client.query(
          "SELECT spent_usd, reserved_usd FROM llm_daily_usage WHERE user_id = $1 AND usage_date = $2",
          [userId, usageDate]
        );
        const current = Number(row.rows[0]?.spent_usd || 0) + Number(row.rows[0]?.reserved_usd || 0);
        throw budgetError("LLM_DAILY_BUDGET_EXCEEDED",
          "Daily AI budget reached. Spent/reserved $" + current.toFixed(4) +
          " of $" + budget.toFixed(2) + ". Try again after the UTC daily reset or adjust your configured limit.");
      }
      await client.query(
        `INSERT INTO llm_usage_reservations
          (id, user_id, usage_date, provider, model, reserved_usd, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
        [id, userId, usageDate, provider, model, reservedUsd]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } else {
    const db = getDatabase();
    const reserve = db.transaction(() => {
      db.prepare("INSERT OR IGNORE INTO llm_daily_usage (user_id, usage_date) VALUES (?, ?)").run(userId, usageDate);
      const row = db.prepare("SELECT spent_usd, reserved_usd FROM llm_daily_usage WHERE user_id = ? AND usage_date = ?").get(userId, usageDate);
      const current = Number(row.spent_usd) + Number(row.reserved_usd);
      if (current + reservedUsd > budget) {
        throw budgetError("LLM_DAILY_BUDGET_EXCEEDED",
          "Daily AI budget reached. Spent/reserved $" + current.toFixed(4) +
          " of $" + budget.toFixed(2) + ". Try again after the UTC daily reset or adjust your configured limit.");
      }
      db.prepare("UPDATE llm_daily_usage SET reserved_usd = reserved_usd + ?, request_count = request_count + 1, updated_at = datetime('now') WHERE user_id = ? AND usage_date = ?")
        .run(reservedUsd, userId, usageDate);
      db.prepare("INSERT INTO llm_usage_reservations (id, user_id, usage_date, provider, model, reserved_usd, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')")
        .run(id, userId, usageDate, provider, model, reservedUsd);
    });
    reserve();
  }

  return { id, userId, usageDate, provider, model, reservedUsd, pricing };
}

export async function settleLlmBudget(reservation, usage = {}) {
  if (!reservation) return { costUsd: 0, dailySpentUsd: null };
  const inputTokens = Math.max(0, Number(usage.inputTokens) || 0);
  const outputTokens = Math.max(0, Number(usage.outputTokens) || 0);
  const costUsd = estimateCost(inputTokens, outputTokens, reservation.pricing);
  const pool = getPostgresPool();

  if (config.databaseUrl && !pool) {
    throw budgetError("LLM_BUDGET_LEDGER_UNAVAILABLE", "The shared PostgreSQL usage ledger is unavailable; spend could not be settled.");
  }

  let dailySpentUsd = 0;
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const item = await client.query(
        "SELECT status, reserved_usd FROM llm_usage_reservations WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [reservation.id, reservation.userId]
      );
      if (!item.rowCount || item.rows[0].status !== "pending") {
        const existing = await client.query("SELECT spent_usd FROM llm_daily_usage WHERE user_id = $1 AND usage_date = $2", [reservation.userId, reservation.usageDate]);
        dailySpentUsd = Number(existing.rows[0]?.spent_usd || 0);
        await client.query("COMMIT");
        return { costUsd, dailySpentUsd, duplicate: true };
      }
      await client.query(
        "UPDATE llm_usage_reservations SET status = 'settled', actual_usd = $2, input_tokens = $3, output_tokens = $4, settled_at = CURRENT_TIMESTAMP WHERE id = $1",
        [reservation.id, costUsd, inputTokens, outputTokens]
      );
      const updated = await client.query(
        `UPDATE llm_daily_usage
         SET reserved_usd = GREATEST(0, reserved_usd - $3),
             spent_usd = spent_usd + $4,
             input_tokens = input_tokens + $5,
             output_tokens = output_tokens + $6,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND usage_date = $2
         RETURNING spent_usd`,
        [reservation.userId, reservation.usageDate, Number(item.rows[0].reserved_usd), costUsd, inputTokens, outputTokens]
      );
      dailySpentUsd = Number(updated.rows[0]?.spent_usd || 0);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } else {
    const db = getDatabase();
    const settle = db.transaction(() => {
      const item = db.prepare("SELECT status, reserved_usd FROM llm_usage_reservations WHERE id = ? AND user_id = ?")
        .get(reservation.id, reservation.userId);
      if (!item || item.status !== "pending") {
        const existing = db.prepare("SELECT spent_usd FROM llm_daily_usage WHERE user_id = ? AND usage_date = ?")
          .get(reservation.userId, reservation.usageDate);
        return { dailySpentUsd: Number(existing?.spent_usd || 0), duplicate: true };
      }
      db.prepare("UPDATE llm_usage_reservations SET status = 'settled', actual_usd = ?, input_tokens = ?, output_tokens = ?, settled_at = datetime('now') WHERE id = ?")
        .run(costUsd, inputTokens, outputTokens, reservation.id);
      db.prepare(`UPDATE llm_daily_usage
        SET reserved_usd = MAX(0, reserved_usd - ?), spent_usd = spent_usd + ?,
            input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, updated_at = datetime('now')
        WHERE user_id = ? AND usage_date = ?`)
        .run(Number(item.reserved_usd), costUsd, inputTokens, outputTokens, reservation.userId, reservation.usageDate);
      const updated = db.prepare("SELECT spent_usd FROM llm_daily_usage WHERE user_id = ? AND usage_date = ?")
        .get(reservation.userId, reservation.usageDate);
      return { dailySpentUsd: Number(updated.spent_usd), duplicate: false };
    });
    const result = settle();
    dailySpentUsd = result.dailySpentUsd;
    if (result.duplicate) return { costUsd, dailySpentUsd, duplicate: true };
  }
  return { costUsd, dailySpentUsd, duplicate: false };
}
