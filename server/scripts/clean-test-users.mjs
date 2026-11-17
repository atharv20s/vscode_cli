import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const { initPostgres, closePostgres } = await import("../src/db/postgres.js");

async function main() {
  const pool = await initPostgres(process.env.DATABASE_URL);
  const users = await pool.query("SELECT id, username FROM users;");
  console.log("Current users in Neon:", users.rows);
  
  await pool.query("DELETE FROM users WHERE id LIKE 'usr_neon_%';");
  
  const remaining = await pool.query("SELECT count(*)::int AS count FROM users;");
  console.log("Users remaining after cleanup:", remaining.rows[0].count);
  await closePostgres();
}

main().catch(console.error);

