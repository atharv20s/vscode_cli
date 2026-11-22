import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const { initPostgres, closePostgres } = await import("../src/db/postgres.js");

async function main() {
  const connStr = process.env.DATABASE_URL;
  console.log("Connecting to:", connStr ? connStr.replace(/:[^:@]+@/, ":****@") : "none");
  const pool = await initPostgres(connStr);
  
  const tables = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;"
  );
  console.log("\n=================================================");
  console.log("TABLES IN NEON POSTGRESQL:");
  console.log("=================================================");
  for (const t of tables.rows) {
    const count = await pool.query(`SELECT COUNT(*)::int AS count FROM ${t.table_name};`);
    console.log(`  - ${t.table_name.padEnd(30)}: ${count.rows[0].count} rows`);
  }
  
  await closePostgres();
}

main().catch(err => {
  console.error("Inspect error:", err);
  process.exit(1);
});

