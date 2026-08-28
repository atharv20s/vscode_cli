/**
 * Main Server Entry Point — Pure JavaScript Backend
 *
 * Combines:
 * - Express HTTP REST/SSE APIs
 * - Raw WebSocket Server for Real-Time Cursor-Like Agent Interaction
 * - SQLite Embedded Database
 * - MCP Server/Client Subsystem
 * - Tavily Search & Octokit GitHub Integration
 * - Static SPA Serving for Browser IDE
 */

import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import helmet from "helmet";

import { config, validateConfig } from "./config/env.js";
import { logger } from "./config/logger.js";
import { initDatabase, closeDatabase } from "./db/database.js";
import { initPostgres } from "./db/postgres.js";
import { initializeTools } from "./tools/index.js";
import { initMcpServers, shutdownMcpServers, getMcpStatus } from "./mcp/mcpClient.js";
import { initWebSocketServer } from "./websocket/wsServer.js";
import { generalLimiter } from "./middleware/rateLimiter.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";

// Routes
import authRoutes from "./routes/authRoutes.js";
import agentRoutes from "./routes/agentRoutes.js";
import workspaceRoutes from "./routes/workspaceRoutes.js";
import githubRoutes from "./routes/githubRoutes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. Initialize Express App & HTTP Server
const app = express();
const server = http.createServer(app);

// 2. Security & Core Middleware
app.use(
  helmet({
    contentSecurityPolicy: false, // Allow CDN scripts for CodeMirror / Monaco in Dev
    crossOriginEmbedderPolicy: false,
  })
);

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-user-id", "X-User-Id", "*"],
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// 3. Static Files for Live Workspace Preview & Browser IDE UI
app.use("/preview", express.static(config.workspaceRoot));
app.use("/preview", (req, res) => {
  res.status(404).send(`<!DOCTYPE html><html><body style="background:#0f172a;color:#f8fafc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center;"><h2>Preview File Not Found</h2><p style="color:#94a3b8;">${req.path} was not found in the workspace root.</p></div></body></html>`);
});
const publicDir = path.resolve(__dirname, "../public");
app.use(express.static(publicDir));

// 4. API Routes
app.use("/api", generalLimiter);

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    version: "1.0.0",
    uptime: `${process.uptime().toFixed(0)}s`,
    mcp: getMcpStatus(),
    env: config.nodeEnv,
    time: new Date().toISOString(),
  });
});

// Live System Health Metrics endpoint (CPU, RAM, Queue)
app.get("/api/health/metrics", async (req, res) => {
  const { systemHealthService } = await import("./services/systemHealthService.js");
  res.json(systemHealthService.getMetrics());
});

// Compilation & Execution Queue Status endpoint
app.get("/api/queue/status", async (req, res) => {
  const { executionQueue } = await import("./services/executionQueue.js");
  res.json(executionQueue.getStatus());
});

// Direct LLM test endpoint — bypasses agent loop entirely
app.get("/api/test-llm", async (req, res) => {
  try {
    const OpenAI = (await import("openai")).default;
    const mistralKey = config.mistralKey || process.env.MISTRAL_API_KEY;
    const openrouterKey = config.openrouterKey || process.env.OPENROUTER_API_KEY;

    const useKey = mistralKey || openrouterKey;
    const baseURL = mistralKey ? "https://api.mistral.ai/v1" : "https://openrouter.ai/api/v1";
    const modelId = mistralKey ? "mistral-small-latest" : "openrouter/free";

    if (!useKey) {
      return res.json({ error: "No LLM API key found in env", mistralKey: !!mistralKey, openrouterKey: !!openrouterKey });
    }

    logger.info(`test-llm: Using ${mistralKey ? 'Mistral Direct' : 'OpenRouter'} with model ${modelId}`);

    const client = new OpenAI({ apiKey: useKey, baseURL });
    const response = await client.chat.completions.create({
      model: modelId,
      messages: [{ role: "user", content: "Say 'ATH IDE is alive!' in exactly 5 words." }],
      max_tokens: 50,
    });

    res.json({
      success: true,
      provider: mistralKey ? "Mistral AI Direct" : "OpenRouter",
      model: modelId,
      response: response.choices[0]?.message?.content,
      keyPrefix: useKey.slice(0, 8) + "...",
    });
  } catch (err) {
    logger.error("test-llm FAILED", { error: err.message, status: err.status });
    res.json({ success: false, error: err.message, status: err.status });
  }
});

app.use("/api/auth", authRoutes);
app.use("/api/agent", agentRoutes);
app.use("/api/workspace", workspaceRoutes);
app.use("/api/github", githubRoutes);

// Kubernetes Cluster & Pod status endpoint
app.get("/api/k8s/status", async (req, res) => {
  const { isK8sAvailable, listUserPods } = await import("./services/k8sService.js");
  const available = await isK8sAvailable();
  const pods = available ? await listUserPods() : [];
  res.json({
    kubernetes: available,
    namespace: process.env.K8S_NAMESPACE || "ath-ide",
    activeUserPods: pods.length,
    pods,
  });
});

// 5. Fallback for SPA routing
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return next();
  }
  res.sendFile(path.join(publicDir, "index.html"));
});

// 6. Error Handling
app.use(notFoundHandler);
app.use(errorHandler);

// 7. Startup sequence
async function startServer() {
  try {
    // Validate configuration
    const { warnings, errors } = validateConfig();
    for (const w of warnings) logger.warn(w);
    for (const e of errors) logger.error(e);

    // Initialize Database (Neon Cloud PostgreSQL if configured, plus SQLite local cache)
    if (config.databaseUrl) {
      try {
        await initPostgres(config.databaseUrl);
      } catch (pgErr) {
        logger.warn(`Postgres initial connect failed: ${pgErr.message}. Falling back to local SQLite database.`);
      }
    }
    initDatabase();
    logger.info("Database subsystem initialized successfully");

    // Initialize Built-in Agent Tools
    initializeTools();
    logger.info("Agent tool registry initialized");

    // Initialize WebSocket Server
    initWebSocketServer(server);

    // Initialize External MCP Servers in background
    initMcpServers().catch((err) => logger.warn("MCP init background error", { error: err.message }));

    // Start System Health Monitoring & Load Balancing Service
    const { systemHealthService } = await import("./services/systemHealthService.js");
    systemHealthService.start(3000);

    // Start HTTP Server
    server.listen(config.port, () => {
      logger.info(`====================================================`);
      logger.info(`🚀 Agentic AI Studio Server running on port ${config.port}`);
      logger.info(`🌐 Web IDE Studio: http://localhost:${config.port}`);
      logger.info(`⚡ WebSocket endpoint: ws://localhost:${config.port}/ws`);
      logger.info(`📡 Health check: http://localhost:${config.port}/api/health`);
      logger.info(`====================================================`);
    });
  } catch (err) {
    logger.error("Failed to start server", { error: err.stack || err.message });
    process.exit(1);
  }
}

// Graceful shutdown handling
async function handleShutdown(signal) {
  logger.info(`Gracefully shutting down on ${signal}...`);
  try {
    const { systemHealthService } = await import("./services/systemHealthService.js");
    systemHealthService.stop();
  } catch {}

  try {
    await shutdownMcpServers();
  } catch {}

  try {
    closeDatabase();
  } catch {}

  // Force exit after 300ms if sockets take too long to close
  const forceTimer = setTimeout(() => {
    process.exit(0);
  }, 300);

  server.close(() => {
    clearTimeout(forceTimer);
    logger.info("Server terminated.");
    process.exit(0);
  });
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));

startServer();
