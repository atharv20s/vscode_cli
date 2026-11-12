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
import crypto from "crypto";
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
import { eventBus } from "./websocket/eventBus.js";
import { generalLimiter } from "./middleware/rateLimiter.js";
import { previewAuth, requireAuth, verifyPreviewToken } from "./middleware/auth.js";
import { agentLimiter } from "./middleware/rateLimiter.js";
import { streamChatCompletion } from "./services/llmService.js";
import { getWorkspaceService } from "./services/workspaceService.js";
import { proxyRemotePreview, proxyRemotePreviewUpgrade } from "./services/remoteExecutionWorker.js";
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
    allowedHeaders: ["Content-Type", "Authorization", "X-ATH-Share-Token", "X-Workspace-Id", "If-Match", "If-None-Match"],
  })
);

app.use(express.json({ limit: "10mb", verify: (req, _res, buf) => { req.rawBody = Buffer.from(buf); } }));
app.use(express.urlencoded({ extended: true, limit: "10mb", verify: (req, _res, buf) => { req.rawBody = Buffer.from(buf); } }));

// 3. Private workspace preview. Never serve the shared workspace root.
// Resolve every requested path through the symlink-aware workspace boundary
// check before sending a file.
app.use("/preview", previewAuth, async (req, res) => {
  try {
    const workspace = getWorkspaceService(req.user.id, req.previewWorkspaceId);
    if (workspace.workspaceId !== crypto.createHash("sha256").update(req.user.id).digest("hex") + ":" + req.previewWorkspaceId) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (config.executionRuntime === "remote") {
      if (!req.previewPort) return res.status(400).json({ error: "PreviewPortMissing" });
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Robots-Tag", "noindex, nofollow");
      return await proxyRemotePreview(req, res, {
        workspaceId: workspace.workspaceId,
        port: req.previewPort,
        previewPath: req.previewPath,
      });
    }
    const relativePath = req.previewPath || "index.html";
    const target = workspace.resolvePath(relativePath);
    if (!target.safe) return res.status(403).json({ error: "Forbidden", message: "Preview path is outside your workspace." });
    res.setHeader("Referrer-Policy", "no-referrer");
    return res.sendFile(target.resolved, { dotfiles: "deny" }, error => {
      if (error && !res.headersSent) res.status(error.statusCode || 404).end();
    });
  } catch (error) {
    return res.status(400).json({ error: "InvalidPreviewPath", message: error.message });
  }
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
app.get("/api/health/metrics", requireAuth, async (req, res) => {
  const { systemHealthService } = await import("./services/systemHealthService.js");
  res.json(systemHealthService.getMetrics());
});

// Compilation & Execution Queue Status endpoint
app.get("/api/queue/status", requireAuth, async (req, res) => {
  const { executionQueue } = await import("./services/executionQueue.js");
  res.json(executionQueue.getStatus());
});

// Distributed Cluster Topology & Multi-Instance Registry endpoint
app.get("/api/cluster/nodes", requireAuth, async (req, res) => {
  const { clusterManager } = await import("./services/clusterManager.js");
  const nodes = await clusterManager.getClusterNodes();
  res.json({
    currentInstanceId: clusterManager.instanceId,
    nodeCount: nodes.length,
    nodes,
  });
});

// Kafka Distributed Queue Status endpoint
app.get("/api/kafka/status", requireAuth, async (req, res) => {
  const { kafkaService } = await import("./services/kafkaService.js");
  res.json({
    connected: kafkaService.isConnected,
    brokers: kafkaService.brokers,
    consumerActive: kafkaService.isConsumerRunning,
    groupId: kafkaService.groupId,
  });
});

// Provider diagnostic uses the exact configured model-routing path as agent requests.
// It is authenticated and rate-limited because every call may consume provider credits.
app.get("/api/test-llm", requireAuth, agentLimiter, async (req, res) => {
  let responseText = "";
  let selectedModel = null;
  let usage = null;
  let failure = null;
  await streamChatCompletion({
    messages: [{ role: "user", content: "Say 'ATH IDE is alive!' in exactly five words." }],
    model: "devstral-low",
    userId: req.user.id,
    onEvent: event => {
      if (event.type === "text_delta") responseText += event.data?.content || "";
      if (event.type === "model_selected") selectedModel = event.data;
      if (event.type === "usage") usage = event.data;
      if (event.type === "error") failure = event.data?.message || "Model diagnostic failed.";
    },
  });
  if (failure || !selectedModel) {
    return res.status(502).json({ success: false, error: failure || "No configured fast-tier model is available." });
  }
  return res.json({ success: true, provider: selectedModel.provider, model: selectedModel.model, response: responseText, usage });
});

app.use("/api/auth", authRoutes);
app.use("/api/agent", agentRoutes);
app.use("/api/workspace", workspaceRoutes);
app.use("/api/github", githubRoutes);

// Kubernetes Cluster & Pod status endpoint
app.get("/api/k8s/status", requireAuth, async (req, res) => {
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

    // Initialize cross-instance workspace event fan-out before registering WebSocket listeners.
    await eventBus.initialize({ redisUrl: config.redisUrl, required: config.requireDistributedEvents });

    // Initialize Built-in Agent Tools
    initializeTools();
    logger.info("Agent tool registry initialized");

    // Repository-agent tasks are durable in Postgres and Redis Streams.
    // Dedicated consumers reclaim expired pending messages after worker restarts.

    // Initialize WebSocket Server
    initWebSocketServer(server);

    // Preview WebSocket upgrades (Vite/Next HMR) use the same capability
    // token and worker tunnel as HTTP assets. The preview runs on a separate
    // PREVIEW_PUBLIC_URL origin, never the authenticated IDE origin.
    server.on("upgrade", (req, socket, head) => {
      let parsed;
      try { parsed = new URL(req.url, "http://" + (req.headers.host || "localhost")); }
      catch { socket.destroy(); return; }
      if (!parsed.pathname.startsWith("/preview/")) return;
      const segments = parsed.pathname.split("/").filter(Boolean);
      const decoded = verifyPreviewToken(segments[1] || "");
      if (!decoded || !Number.isInteger(decoded.port) || decoded.port < 1024 || decoded.port > 65535) {
        socket.write("HTTP/1.1 401 Unauthorized\\r\\nConnection: close\\r\\n\\r\\n");
        socket.destroy();
        return;
      }
      try {
        const workspace = getWorkspaceService(decoded.sub, decoded.workspaceId);
        if (config.executionRuntime !== "remote") {
          socket.write("HTTP/1.1 503 Preview Unavailable\\r\\nConnection: close\\r\\n\\r\\n");
          socket.destroy();
          return;
        }
        const previewPath = segments.slice(2).map(segment => decodeURIComponent(segment)).join("/");
        proxyRemotePreviewUpgrade(req, socket, head, {
          workspaceId: workspace.workspaceId,
          port: decoded.port,
          previewPath,
        });
      } catch { socket.destroy(); }
    });

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
    await eventBus.shutdown();
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
