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
import { readCgroupV2Metrics } from "./cgroupMetrics.js";

class SystemHealthService {
  constructor() {
    this._interval = null;
    this._lastCpuMeasure = this._getCpuTimes();
    this._lastCgroupCpu = null;
    this._lastCgroupSampleAt = null;
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
    const cpus = os.cpus() || [];
    let idle = 0;
    let total = 0;
    for (const cpu of cpus) {
      if (cpu && cpu.times) {
        for (const t of Object.keys(cpu.times)) {
          total += cpu.times[t];
        }
        idle += (cpu.times.idle || 0);
      }
    }
    return { idle, total };
  }

  async sample() {
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
      let memoryUsed = usedMem;
      let memoryTotal = totalMem;
      let memoryPercent = Math.round((usedMem / totalMem) * 100);
      let cpuPercent = cpuUsage;
      let cgroup = null;
      if (process.platform === "linux") {
        try { cgroup = await readCgroupV2Metrics(); } catch (error) {
          logger.debug("Could not read Linux cgroup usage", { error: error.message });
        }
      }
      const sampledAt = Date.now();
      if (cgroup) {
        if (Number.isFinite(cgroup.memoryUsedBytes)) memoryUsed = cgroup.memoryUsedBytes;
        if (Number.isFinite(cgroup.memoryLimitBytes) && cgroup.memoryLimitBytes > 0) memoryTotal = cgroup.memoryLimitBytes;
        memoryPercent = memoryTotal > 0 ? Math.min(100, Math.round((memoryUsed / memoryTotal) * 100)) : 0;
        if (Number.isFinite(cgroup.cpuUsageUsec) && this._lastCgroupCpu !== null && this._lastCgroupSampleAt !== null) {
          const elapsedMs = Math.max(1, sampledAt - this._lastCgroupSampleAt);
          const cpuCapacity = cgroup.cpuLimitCores || Math.max(1, os.cpus().length);
          const usedCores = (cgroup.cpuUsageUsec - this._lastCgroupCpu) / (elapsedMs * 1000);
          cpuPercent = Math.max(0, Math.min(100, Math.round((usedCores / cpuCapacity) * 100)));
        }
        this._lastCgroupCpu = cgroup.cpuUsageUsec;
        this._lastCgroupSampleAt = sampledAt;
      }
      const memUsage = process.memoryUsage();

      const queueStatus = executionQueue.getStatus();

      // 3. Health status classification
      const pidsPercent = cgroup?.processCount != null && cgroup?.processLimit > 0
        ? Math.round((cgroup.processCount / cgroup.processLimit) * 100)
        : 0;
      let status = "healthy";
      if (cpuPercent > 90 || memoryPercent > 92 || pidsPercent > 95) {
        status = "critical";
      } else if (cpuPercent > 75 || memoryPercent > 80 || pidsPercent > 85 || queueStatus.queuedJobs > 20) {
        status = "degraded";
      }

      this.currentMetrics = {
        cpuPercent,
        hostCpuPercent: cpuUsage,
        memoryUsedMB: Math.round(memoryUsed / (1024 * 1024)),
        memoryTotalMB: Math.round(memoryTotal / (1024 * 1024)),
        cgroup: cgroup ? {
          version: 2,
          cpuLimitCores: cgroup.cpuLimitCores,
          memoryLimitBytes: cgroup.memoryLimitBytes,
          processCount: cgroup.processCount,
          processLimit: cgroup.processLimit,
          pidsPercent,
          memoryEvents: cgroup.memoryEvents,
          pressure: cgroup.pressure,
        } : null,
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
        timestamp: sampledAt,
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
