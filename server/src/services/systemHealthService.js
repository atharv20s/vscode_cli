/**
 * System Health & Overload Protection Service
 * 
 * Periodically measures CPU utilization, memory thresholds, process count,
 * and queue pressure. Emits system.health broadcasts over WebSocket and
 * provides circuit breaking when resources near critical limits.
 */

import os from "os";
import { logger } from "../config/logger.js";
import { eventBus } from "../websocket/eventBus.js";
import { executionQueue } from "./executionQueue.js";

class SystemHealthService {
  constructor() {
    this._interval = null;
    this._lastCpuMeasure = this._getCpuTimes();
    this.currentMetrics = {
      cpuPercent: 0,
      memoryUsedMB: 0,
      memoryTotalMB: 0,
      memoryPercent: 0,
      processHeapMB: 0,
      uptimeSeconds: 0,
      queue: { queued: 0, running: 0 },
      status: "healthy", // 'healthy' | 'degraded' | 'critical'
      timestamp: Date.now(),
    };
  }

  start(intervalMs = 3000) {
    if (this._interval) return;

    this.sample();
    this._interval = setInterval(() => this.sample(), intervalMs);
    logger.info("System health monitoring service started");
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  _getCpuTimes() {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    for (const cpu of cpus) {
      for (const type in cpu.times) {
        total += cpu.times[type];
      }
      idle += cpu.times.idle;
    }
    return { idle, total };
  }

  sample() {
    try {
      // 1. Calculate CPU Percent
      const current = this._getCpuTimes();
      const idleDiff = current.idle - this._lastCpuMeasure.idle;
      const totalDiff = current.total - this._lastCpuMeasure.total;
      this._lastCpuMeasure = current;

      const cpuUsage = totalDiff > 0 ? Math.max(0, Math.min(100, Math.round((1 - idleDiff / totalDiff) * 100))) : 0;

      // 2. Memory stats
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const memoryPercent = Math.round((usedMem / totalMem) * 100);
      const memUsage = process.memoryUsage();

      const queueStatus = executionQueue.getStatus();

      // 3. Health status classification
      let status = "healthy";
      if (cpuUsage > 90 || memoryPercent > 92) {
        status = "critical";
      } else if (cpuUsage > 75 || memoryPercent > 80 || queueStatus.queuedJobs > 20) {
        status = "degraded";
      }

      this.currentMetrics = {
        cpuPercent: cpuUsage,
        memoryUsedMB: Math.round(usedMem / (1024 * 1024)),
        memoryTotalMB: Math.round(totalMem / (1024 * 1024)),
        memoryPercent,
        processHeapMB: Math.round(memUsage.heapUsed / (1024 * 1024)),
        processRssMB: Math.round(memUsage.rss / (1024 * 1024)),
        uptimeSeconds: Math.round(process.uptime()),
        queue: {
          queued: queueStatus.queuedJobs,
          running: queueStatus.runningJobs,
          totalProcessed: queueStatus.stats.totalProcessed,
        },
        status,
        timestamp: Date.now(),
      };

      // 4. Broadcast live health event across WebSocket
      eventBus.publish("system.health", this.currentMetrics, { source: "health_monitor" });
    } catch (err) {
      logger.debug(`Health check sample error: ${err.message}`);
    }
  }

  getMetrics() {
    return this.currentMetrics;
  }
}

export const systemHealthService = new SystemHealthService();
