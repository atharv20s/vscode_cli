/**
 * WebSocket Connection Manager
 *
 * Tracks active connections per user, handles lifecycle,
 * and provides broadcast/unicast messaging.
 */

import { logger } from "../config/logger.js";

/** @type {Map<string, Set<import('ws').WebSocket>>} */
const userConnections = new Map();

/** @type {Map<import('ws').WebSocket, object>} */
const connectionMeta = new Map();

/**
 * Register a new WebSocket connection for a user.
 */
export function addConnection(ws, user) {
  const userId = user?.id || "anonymous";

  if (!userConnections.has(userId)) {
    userConnections.set(userId, new Set());
  }
  userConnections.get(userId).add(ws);

  connectionMeta.set(ws, {
    userId,
    username: user?.username || "anonymous",
    connectedAt: new Date(),
    messageCount: 0,
    lastActivity: new Date(),
  });

  logger.info(`WebSocket connected: ${user?.username || "anonymous"}`, {
    userId,
    totalConnections: getTotalConnections(),
  });
}

/**
 * Remove a WebSocket connection.
 */
export function removeConnection(ws) {
  const meta = connectionMeta.get(ws);
  if (!meta) return;

  const userSet = userConnections.get(meta.userId);
  if (userSet) {
    userSet.delete(ws);
    if (userSet.size === 0) {
      userConnections.delete(meta.userId);
    }
  }

  connectionMeta.delete(ws);

  logger.info(`WebSocket disconnected: ${meta.username}`, {
    userId: meta.userId,
    sessionDuration: `${((Date.now() - meta.connectedAt.getTime()) / 1000).toFixed(0)}s`,
    messagesHandled: meta.messageCount,
  });
}

/**
 * Record a message received on a connection.
 */
export function recordMessage(ws) {
  const meta = connectionMeta.get(ws);
  if (meta) {
    meta.messageCount++;
    meta.lastActivity = new Date();
  }
}

/**
 * Send a message to a specific WebSocket.
 */
export function sendMessage(ws, type, payload) {
  if (ws.readyState === 1) {
    // WebSocket.OPEN
    ws.send(JSON.stringify({ type, payload }));
  }
}

/**
 * Broadcast a message to all connections of a specific user.
 */
export function broadcastToUser(userId, type, payload) {
  const connections = userConnections.get(userId);
  if (!connections) return;

  const message = JSON.stringify({ type, payload });
  for (const ws of connections) {
    if (ws.readyState === 1) {
      ws.send(message);
    }
  }
}

/**
 * Broadcast a message to ALL connected clients.
 */
export function broadcastAll(type, payload) {
  const message = JSON.stringify({ type, payload });
  for (const [, connections] of userConnections) {
    for (const ws of connections) {
      if (ws.readyState === 1) {
        ws.send(message);
      }
    }
  }
}

/**
 * Get total number of active connections.
 */
export function getTotalConnections() {
  let total = 0;
  for (const [, connections] of userConnections) {
    total += connections.size;
  }
  return total;
}

export const getConnectionCount = getTotalConnections;

/**
 * Get connection stats.
 */
export function getConnectionStats() {
  const stats = [];
  for (const [userId, connections] of userConnections) {
    for (const ws of connections) {
      const meta = connectionMeta.get(ws);
      if (meta) {
        stats.push({
          userId,
          username: meta.username,
          connectedAt: meta.connectedAt.toISOString(),
          messageCount: meta.messageCount,
          lastActivity: meta.lastActivity.toISOString(),
        });
      }
    }
  }
  return stats;
}

/**
 * Disconnect idle connections (no activity for the given duration).
 */
export function disconnectIdle(maxIdleMs = 30 * 60 * 1000) {
  const now = Date.now();
  let disconnected = 0;

  for (const [, connections] of userConnections) {
    for (const ws of connections) {
      const meta = connectionMeta.get(ws);
      if (meta && now - meta.lastActivity.getTime() > maxIdleMs) {
        sendMessage(ws, "disconnect", { reason: "idle timeout" });
        ws.close(1000, "Idle timeout");
        disconnected++;
      }
    }
  }

  if (disconnected > 0) {
    logger.info(`Disconnected ${disconnected} idle connections`);
  }
}
