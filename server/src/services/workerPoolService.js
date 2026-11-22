/**
 * Worker Pool & Lifecycle Service (Milestone 2.0 / PR #65)
 *
 * Coordinates a pool of isolated Linux/Docker execution workers:
 * - Dynamic worker registration & heartbeat tracking
 * - Least-loaded worker selection for job dispatch
 * - Stale worker eviction & automated job recovery
 * - Per-tenant concurrency limits
 */

import { logger } from "../config/logger.js";
import { eventBus } from "../websocket/eventBus.js";

const DEFAULT_HEARTBEAT_TTL_MS = 15_000;
const MAX_CONCURRENT_PER_TENANT = 4;

export class WorkerPoolService {
  constructor(options = {}) {
    this.heartbeatTtlMs = options.heartbeatTtlMs || DEFAULT_HEARTBEAT_TTL_MS;
    this.maxConcurrentPerTenant = options.maxConcurrentPerTenant || MAX_CONCURRENT_PER_TENANT;
    this.workers = new Map(); // workerId -> { id, address, maxTasks, activeTasks: Set(taskId), lastHeartbeat, status, tags }
    this.tasks = new Map();   // taskId -> { id, tenantId, workerId, status, command, retries, createdAt }
    this._maintenanceTimer = null;
  }

  /**
   * Register or update worker heartbeat.
   */
  registerWorker({ workerId, address, maxTasks = 8, tags = [] }) {
    if (!workerId || typeof workerId !== "string") throw new Error("A valid workerId is required.");
    const existing = this.workers.get(workerId);
    const worker = existing || {
      id: workerId,
      address: address || "localhost",
      maxTasks: Math.max(1, Number(maxTasks) || 8),
      activeTasks: new Set(),
      tags: Array.isArray(tags) ? tags : [],
      status: "healthy",
      lastHeartbeat: Date.now(),
    };
    worker.lastHeartbeat = Date.now();
    worker.status = "healthy";
    if (address) worker.address = address;
    this.workers.set(workerId, worker);
    return worker;
  }

  /**
   * Record worker heartbeat.
   */
  heartbeat(workerId, metrics = {}) {
    const worker = this.workers.get(workerId);
    if (!worker) return false;
    worker.lastHeartbeat = Date.now();
    worker.status = "healthy";
    if (metrics.activeTasksCount !== undefined) {
      worker.reportedTaskCount = metrics.activeTasksCount;
    }
    return true;
  }

  /**
   * Select the best worker for a task based on capacity and tag matching.
   * Supports idempotent reservation for identical active task IDs.
   */
  assignWorker(taskId, tenantId, options = {}) {
    if (!taskId || !tenantId) throw new Error("taskId and tenantId are required.");

    // Idempotent reservation: return existing active worker if already assigned
    const existingTask = this.tasks.get(taskId);
    if (existingTask && existingTask.status === "running") {
      const existingWorker = this.workers.get(existingTask.workerId);
      if (existingWorker && (Date.now() - existingWorker.lastHeartbeat) <= this.heartbeatTtlMs) {
        return existingWorker;
      }
    }

    // Check tenant concurrency limit
    const tenantActiveCount = [...this.tasks.values()]
      .filter(t => t.tenantId === tenantId && t.status === "running").length;
    if (tenantActiveCount >= this.maxConcurrentPerTenant) {
      throw new Error(`Tenant '${tenantId}' has reached maximum concurrent worker tasks (${this.maxConcurrentPerTenant}).`);
    }

    const now = Date.now();
    const requiredTag = options.requiredTag || null;

    // Filter healthy, active workers with remaining capacity
    const candidates = [...this.workers.values()].filter(w => {
      const isAlive = (now - w.lastHeartbeat) <= this.heartbeatTtlMs;
      const hasCapacity = w.activeTasks.size < w.maxTasks;
      const matchesTag = !requiredTag || w.tags.includes(requiredTag);
      return isAlive && hasCapacity && w.status === "healthy";
    });

    if (!candidates.length) return null;

    // Pick least loaded worker
    candidates.sort((a, b) => (a.activeTasks.size / a.maxTasks) - (b.activeTasks.size / b.maxTasks));
    const selected = candidates[0];

    selected.activeTasks.add(taskId);
    this.tasks.set(taskId, {
      id: taskId,
      tenantId,
      workerId: selected.id,
      status: "running",
      createdAt: now,
      retries: 0,
    });

    return selected;
  }

  /**
   * Mark a task completed and release worker capacity idempotently.
   */
  completeTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status === "completed") return true;
    const worker = this.workers.get(task.workerId);
    if (worker) worker.activeTasks.delete(taskId);
    task.status = "completed";
    task.completedAt = Date.now();
    return true;
  }

  /**
   * Release worker capacity for a task idempotently regardless of final state.
   */
  releaseTask(taskId, finalStatus = "completed") {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (["completed", "failed", "cancelled"].includes(task.status)) return true;
    const worker = this.workers.get(task.workerId);
    if (worker) worker.activeTasks.delete(taskId);
    task.status = finalStatus;
    task.completedAt = Date.now();
    return true;
  }

  /**
   * Run maintenance: detect stale workers, evict them, and identify orphaned tasks.
   */
  pruneStaleWorkers() {
    const now = Date.now();
    const orphanedTasks = [];

    for (const [workerId, worker] of this.workers.entries()) {
      const elapsed = now - worker.lastHeartbeat;
      if (elapsed > this.heartbeatTtlMs) {
        logger.warn(`Worker '${workerId}' failed heartbeat (${elapsed}ms ago). Marking dead and recovering tasks.`);
        worker.status = "dead";

        for (const taskId of worker.activeTasks) {
          const task = this.tasks.get(taskId);
          if (task && task.status === "running") {
            task.status = "orphaned";
            task.retries = (task.retries || 0) + 1;
            orphanedTasks.push(task);
          }
        }
        worker.activeTasks.clear();
      }
    }
    return orphanedTasks;
  }

  /**
   * Pool status report for monitoring.
   */
  getStatus() {
    const now = Date.now();
    return {
      totalWorkers: this.workers.size,
      healthyWorkers: [...this.workers.values()].filter(w => (now - w.lastHeartbeat) <= this.heartbeatTtlMs && w.status === "healthy").length,
      activeTasks: [...this.tasks.values()].filter(t => t.status === "running").length,
      workers: [...this.workers.values()].map(w => ({
        id: w.id,
        address: w.address,
        activeTasks: w.activeTasks.size,
        maxTasks: w.maxTasks,
        status: (now - w.lastHeartbeat) > this.heartbeatTtlMs ? "dead" : w.status,
      })),
    };
  }
}

export const workerPoolService = new WorkerPoolService();
