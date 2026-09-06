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

// Distributed Cluster Topology & Multi-Instance Registry endpoint
app.get("/api/cluster/nodes", async (req, res) => {
  const { clusterManager } = await import("./services/clusterManager.js");
  const nodes = await clusterManager.getClusterNodes();
  res.json({
    currentInstanceId: clusterManager.instanceId,
    nodeCount: nodes.length,
    nodes,
  });
});

// Kafka Distributed Queue Status endpoint
app.get("/api/kafka/status", async (req, res) => {
  const { kafkaService } = await import("./services/kafkaService.js");
  res.json({
    connected: kafkaService.isConnected,
    brokers: kafkaService.brokers,
    consumerActive: kafkaService.isConsumerRunning,
    groupId: kafkaService.groupId,
  });
});

// Direct LLM test endpoint with intelligent multi-provider failover
app.get("/api/test-llm", async (req, res) => {
  try {
    const OpenAI = (await import("openai")).default;
    const mistralKey = config.mistralKey || process.env.MISTRAL_API_KEY;
    const openrouterKey = config.openrouterKey || process.env.OPENROUTER_API_KEY;

    const candidates = [];
    if (config.defaultLlmProvider === "openrouter" && openrouterKey) {
      candidates.push({ provider: "OpenRouter", key: openrouterKey, baseURL: "https://openrouter.ai/api/v1", model: "openrouter/free" });
      if (mistralKey) candidates.push({ provider: "Mistral AI Direct", key: mistralKey, baseURL: "https://api.mistral.ai/v1", model: "mistral-small-latest" });
    } else {
      if (mistralKey) candidates.push({ provider: "Mistral AI Direct", key: mistralKey, baseURL: "https://api.mistral.ai/v1", model: "mistral-small-latest" });
      if (openrouterKey) candidates.push({ provider: "OpenRouter", key: openrouterKey, baseURL: "https://openrouter.ai/api/v1", model: "openrouter/free" });
    }

    if (candidates.length === 0) {
      return res.status(500).json({ error: "No LLM API key found in env", mistralKey: Boolean(mistralKey), openrouterKey: Boolean(openrouterKey) });
    }

    let lastError = null;
    for (const c of candidates) {
      try {
        logger.info(`test-llm: Trying ${c.provider} with model ${c.model}...`);
        const client = new OpenAI({ apiKey: c.key, baseURL: c.baseURL });
        const response = await client.chat.completions.create({
          model: c.model,
          messages: [{ role: "user", content: "Say 'ATH IDE is alive!' in exactly 5 words." }],
          max_tokens: 50,
        });

        return res.json({
          success: true,
          provider: c.provider,
          model: c.model,
          response: response.choices[0]?.message?.content,
          keyPrefix: c.key.slice(0, 8) + "...",
        });
      } catch (err) {
        lastError = err;
        logger.warn(`test-llm: Provider ${c.provider} failed: ${err.message}. Trying next candidate...`);
      }
    }

    logger.error("test-llm FAILED on all providers", { error: lastError?.message });
    res.status(lastError?.status || 500).json({ success: false, error: lastError?.message, status: lastError?.status });
  } catch (err) {
    logger.error("test-llm fatal error", { error: err.message });
    res.status(500).json({ success: false, error: err.message });
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

    // Initialize Cluster NoSQL Registry, Kafka Distributed Queue, and DB Sharding
    try {
      const { clusterManager } = await import("./services/clusterManager.js");
      await clusterManager.initialize();
    } catch (cErr) {
      logger.warn(`Cluster manager startup warning: ${cErr.message}`);
    }

    try {
      const { kafkaService } = await import("./services/kafkaService.js");
      await kafkaService.initialize();
    } catch (kErr) {
      logger.warn(`Kafka service startup warning: ${kErr.message}`);
    }

    try {
      const { shardManager } = await import("./db/shardManager.js");
      await shardManager.initialize();
    } catch (sErr) {
      logger.warn(`Shard manager startup warning: ${sErr.message}`);
    }

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
    const { clusterManager } = await import("./services/clusterManager.js");
    await clusterManager.shutdown();
  } catch {}

  try {
    const { kafkaService } = await import("./services/kafkaService.js");
    await kafkaService.shutdown();
  } catch {}

  try {
    const { shardManager } = await import("./db/shardManager.js");
    await shardManager.shutdown();
  } catch {}

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
