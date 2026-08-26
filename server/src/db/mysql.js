/**
 * MySQL Database Layer with Connection Pooling
 *
 * Uses mysql2/promise for async queries.
 * Supports auto-table creation on startup.
 */

import mysql from "mysql2/promise";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";

/** @type {mysql.Pool | null} */
export let mysqlPool = null;

/**
 * Initialize MySQL Connection Pool & Schema.
 */
export async function initMysql() {
  if (mysqlPool) return mysqlPool;

  const host = process.env.MYSQL_HOST || "localhost";
  const port = parseInt(process.env.MYSQL_PORT || "3307", 10);
  const user = process.env.MYSQL_USER || "root";
  const password = process.env.MYSQL_PASSWORD || "secret";
  const database = process.env.MYSQL_DATABASE || "agentic_db";

  try {
    // 1. Create database if it doesn't exist
    const rootConnection = await mysql.createConnection({ host, port, user, password });
    await rootConnection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\`;`);
    await rootConnection.end();

    // 2. Create connection pool
    mysqlPool = mysql.createPool({
      host,
      port,
      user,
      password,
      database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
    });

    // 3. Create tables if not exist
    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(64) PRIMARY KEY,
        github_id BIGINT UNIQUE,
        username VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        avatar_url TEXT,
        github_access_token TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      );
    `);

    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        workspace_path TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id VARCHAR(64) PRIMARY KEY,
        session_id VARCHAR(64) NOT NULL,
        title VARCHAR(255),
        messages JSON,
        model VARCHAR(100),
        total_tokens INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
    `);

    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS cache_entries (
        \`key\` VARCHAR(255) PRIMARY KEY,
        value JSON NOT NULL,
        ttl_seconds INT DEFAULT 300,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    logger.info("✅ MySQL database connected & schemas verified successfully");
    return mysqlPool;
  } catch (err) {
    logger.warn("MySQL initialization note: " + err.message);
    return null;
  }
}

/**
 * Execute a query with MySQL pool.
 */
export async function queryMysql(sql, params = []) {
  if (!mysqlPool) {
    throw new Error("MySQL pool not initialized.");
  }
  const [rows] = await mysqlPool.execute(sql, params);
  return rows;
}
