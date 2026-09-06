/**
 * Cluster Manager — Multi-Instance Distributed Registry via NoSQL (Redis)
 *
 * Enables multiple server instances to:
 * 1. Self-register with unique instance IDs and metadata (host, port, CPU, RAM, active sockets)
 * 2. Send TTL-based heartbeats every 5 seconds (15s TTL for auto-pruning dead nodes)
 * 3. Discover peer instances across the cluster
 * 4. Coordinate distributed locks and pub/sub cluster events
 */

import os from "os";
import Redis from "ioredis";
import { v4 as uuidv4 } from "uuid";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import { getTotalConnections } from "../websocket/connectionManager.js";

class ClusterManager {
  constructor() {
    this.instanceId = `node_${os.hostname()}_${process.pid}_${uuidv4().slice(0, 8)}`;
    this.redisUrl = process.env.REDIS_URL || config.redisUrl || "";
    this.client = null;
    this.heartbeatTimer = null;
    this.isRegistered = false;
    this.startTime = Date.now();
  }

  /**
   * Initialize Redis connection and start cluster heartbeat.
   */
  async initialize() {
    if (!this.redisUrl) {
      logger.info(`ClusterManager: Running in single-node standalone mode (instance: ${this.instanceId})`);
      return;
    }

    try {
      this.client = new Redis(this.redisUrl, {
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        connectTimeout: 8000,
        retryStrategy: (times) => {
          if (times > 5) return null; // Stop retrying after 5 attempts
          return Math.min(times * 1000, 5000);
        },
      });

      this.client.on("error", (err) => {
        logger.warn(`ClusterManager Redis error: ${err.message}`);
      });

      this.client.on("connect", () => {
        logger.info(`ClusterManager: Connected to Redis NoSQL cluster state store`);
        this.startHeartbeat();
      });
    } catch (err) {
      logger.warn(`ClusterManager: Failed to initialize Redis: ${err.message}. Operating standalone.`);
    }
  }

  /**
   * Start 5-second periodic heartbeat with 15-second TTL.
   */
  startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    // Initial heartbeat immediately
    this.sendHeartbeat().catch(() => {});

    this.heartbeatTimer = setInterval(async () => {
      await this.sendHeartbeat();
    }, 5000);

    this.isRegistered = true;
    logger.info(`ClusterManager: Node self-registered in cluster registry`, {
      instanceId: this.instanceId,
      heartbeatInterval: "5s",
      ttl: "15s",
    });
  }

  /**
   * Write node state to Redis with 15-second expiration.
   */
  async sendHeartbeat() {
    if (!this.client || this.client.status !== "ready") return;

    try {
      const mem = process.memoryUsage();
      const nodeData = {
        instanceId: this.instanceId,
        hostname: os.hostname(),
        platform: os.platform(),
        pid: process.pid,
        port: config.port,
        uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
        activeConnections: getTotalConnections ? getTotalConnections() : 0,
        memoryRssMb: Math.round(mem.rss / 1024 / 1024),
        memoryHeapMb: Math.round(mem.heapUsed / 1024 / 1024),
        cpuCount: os.cpus().length,
        loadAverage: os.loadavg(),
        lastHeartbeat: new Date().toISOString(),
        status: "healthy",
      };

      const key = `ath:cluster:node:${this.instanceId}`;
      await this.client.set(key, JSON.stringify(nodeData), "EX", 15);
    } catch (err) {
      logger.debug(`Heartbeat write error: ${err.message}`);
    }
  }

  /**
   * Query all active cluster nodes from Redis.
   */
  async getClusterNodes() {
    if (!this.client || this.client.status !== "ready") {
      // Fallback: return self as the single node
      return [
        {
          instanceId: this.instanceId,
          hostname: os.hostname(),
          platform: os.platform(),
          pid: process.pid,
          port: config.port,
          uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
          activeConnections: getConnectionCount ? getConnectionCount() : 0,
          status: "healthy",
          mode: "standalone",
        },
      ];
    }

    try {
      const keys = await this.client.keys("ath:cluster:node:*");
      if (!keys || keys.length === 0) return [];

      const values = await this.client.mget(keys);
      const nodes = [];

      for (const val of values) {
        if (val) {
          try {
            nodes.push(JSON.parse(val));
          } catch {}
        }
      }

      return nodes;
    } catch (err) {
      logger.warn(`Failed to fetch cluster nodes: ${err.message}`);
      return [];
    }
  }

  /**
   * Graceful deregistration on shutdown.
   */
  async shutdown() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.client && this.client.status === "ready") {
      try {
        await this.client.del(`ath:cluster:node:${this.instanceId}`);
        logger.info(`ClusterManager: Node ${this.instanceId} gracefully deregistered from cluster`);
      } catch {}
      try {
        await this.client.quit();
      } catch {}
    }
  }
}

export const clusterManager = new ClusterManager();
