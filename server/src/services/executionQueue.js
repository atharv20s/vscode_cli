/**
 * Asynchronous Distributed Execution & Compilation Queue
 * 
 * Provides fair-share scheduling, per-user concurrency caps, priority queuing,
 * and overload protection for all compilation, execution, and agent tasks.
 * Prevents server CPU/Memory exhaustion and ensures stable multi-user scaling.
 */

import os from "os";
import { logger } from "../config/logger.js";
import { eventBus, EVENT_TOPICS } from "../websocket/eventBus.js";

/** Configuration constants - High throughput dynamic concurrency */
const CPU_COUNT = os.cpus().length || 4;
const MAX_GLOBAL_CONCURRENT = parseInt(process.env.QUEUE_MAX_GLOBAL_CONCURRENT || String(Math.max(64, CPU_COUNT * 8)), 10);
const MAX_PER_USER_CONCURRENT = parseInt(process.env.QUEUE_MAX_USER_CONCURRENT || String(Math.max(16, CPU_COUNT * 4)), 10);
const MAX_QUEUE_SIZE = parseInt(process.env.QUEUE_MAX_SIZE || "500", 10);
const DEFAULT_JOB_TIMEOUT_MS = parseInt(process.env.QUEUE_JOB_TIMEOUT_MS || "120000", 10);

/**
 * @typedef {'high' | 'normal' | 'low'} JobPriority
 * @typedef {'queued' | 'running' | 'completed' | 'failed' | 'cancelled'} JobStatus
 */

class ExecutionQueue {
  constructor() {
    /** @type {Array<{ id: string, userId: string, priority: JobPriority, taskFn: Function, createdAt: number, timeout: number, status: JobStatus, resolve: Function, reject: Function, metadata: object }>} */
    this.pendingQueue = [];

    /** @type {Map<string, { id: string, userId: string, startTime: number, abortController: AbortController, metadata: object }>} */
    this.runningJobs = new Map();

    /** @type {Map<string, number>} User ID -> Active running jobs count */
    this.userActiveCounts = new Map();

    this.stats = {
      totalProcessed: 0,
      totalFailed: 0,
      totalCancelled: 0,
      peakConcurrent: 0,
    };

    this._isProcessing = false;
  }

  /**
   * Enqueue an asynchronous compilation or execution task.
   * 
   * @param {object} params
   * @param {string} params.userId - User identifier (from JWT or session)
   * @param {Function} params.taskFn - Async function returning execution result
   * @param {JobPriority} [params.priority='normal'] - Priority level
   * @param {number} [params.timeout=60000] - Timeout in ms
   * @param {object} [params.metadata] - Descriptive task info (command, file, tool)
   * @returns {Promise<any>}
   */
  async enqueue({
    userId = "default_user",
    taskFn,
    priority = "normal",
    timeout = DEFAULT_JOB_TIMEOUT_MS,
    metadata = {},
  }) {
    if (this.pendingQueue.length >= MAX_QUEUE_SIZE) {
      throw new Error(`Execution Queue saturated (${this.pendingQueue.length}/${MAX_QUEUE_SIZE} jobs). Please try again in a few moments.`);
    }

    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    return new Promise((resolve, reject) => {
      const jobItem = {
        id: jobId,
        userId: String(userId),
        priority,
        taskFn,
        createdAt: Date.now(),
        timeout,
        status: "queued",
        resolve,
        reject,
        metadata,
      };

      // Priority insertion: 'high' first, then 'normal', then 'low'
      const priorityWeight = { high: 3, normal: 2, low: 1 };
      const weight = priorityWeight[priority] || 2;

      let insertIndex = this.pendingQueue.length;
      for (let i = 0; i < this.pendingQueue.length; i++) {
        const itemWeight = priorityWeight[this.pendingQueue[i].priority] || 2;
        if (weight > itemWeight) {
          insertIndex = i;
          break;
        }
      }

      this.pendingQueue.splice(insertIndex, 0, jobItem);

      logger.debug("Job enqueued", {
        jobId,
        userId,
        priority,
        queuePosition: insertIndex + 1,
        totalQueued: this.pendingQueue.length,
      });

      eventBus.publish("queue.job_enqueued", {
        jobId,
        userId,
        priority,
        position: insertIndex + 1,
        totalQueued: this.pendingQueue.length,
        metadata,
      });

      this._scheduleNext();
    });
  }

  /**
   * Internal scheduler loop.
   */
  _scheduleNext() {
    if (this._isProcessing) return;
    this._isProcessing = true;

    try {
      while (
        this.runningJobs.size < MAX_GLOBAL_CONCURRENT &&
        this.pendingQueue.length > 0
      ) {
        // Find next eligible job that respects per-user concurrency cap
        const jobIndex = this.pendingQueue.findIndex((job) => {
          const userCount = this.userActiveCounts.get(job.userId) || 0;
          return userCount < MAX_PER_USER_CONCURRENT;
        });

        if (jobIndex === -1) {
          // All pending users have reached their per-user concurrency limit
          break;
        }

        const [job] = this.pendingQueue.splice(jobIndex, 1);
        this._executeJob(job);
      }
    } finally {
      this._isProcessing = false;
    }
  }

  /**
   * Execute an individual job under supervised timeout and tracking.
   */
  async _executeJob(job) {
    const { id, userId, taskFn, timeout, resolve, reject, metadata } = job;
    const abortController = new AbortController();

    this.runningJobs.set(id, {
      id,
      userId,
      startTime: Date.now(),
      abortController,
      metadata,
    });

    const userCount = (this.userActiveCounts.get(userId) || 0) + 1;
    this.userActiveCounts.set(userId, userCount);

    if (this.runningJobs.size > this.stats.peakConcurrent) {
      this.stats.peakConcurrent = this.runningJobs.size;
    }

    logger.debug("Job started execution", {
      jobId: id,
      userId,
      activeRunning: this.runningJobs.size,
    });

    eventBus.publish("queue.job_started", {
      jobId: id,
      userId,
      activeRunning: this.runningJobs.size,
      metadata,
    });

    // Timeout guard
    const timer = setTimeout(() => {
      abortController.abort();
      logger.warn(`Job ${id} timed out after ${timeout}ms`);
    }, timeout);

    try {
      const result = await taskFn({ signal: abortController.signal, jobId: id });
      clearTimeout(timer);

      this.stats.totalProcessed++;
      job.status = "completed";

      eventBus.publish("queue.job_completed", {
        jobId: id,
        userId,
        durationMs: Date.now() - job.createdAt,
        metadata,
      });

      resolve(result);
    } catch (err) {
      clearTimeout(timer);
      this.stats.totalFailed++;
      job.status = "failed";

      logger.error("Job execution failed in queue", {
        jobId: id,
        error: err.message,
      });

      eventBus.publish("queue.job_failed", {
        jobId: id,
        userId,
        error: err.message,
        metadata,
      });

      reject(err);
    } finally {
      this.runningJobs.delete(id);
      const updatedUserCount = Math.max(0, (this.userActiveCounts.get(userId) || 1) - 1);
      if (updatedUserCount === 0) {
        this.userActiveCounts.delete(userId);
      } else {
        this.userActiveCounts.set(userId, updatedUserCount);
      }

      // Continue draining queue
      this._scheduleNext();
    }
  }

  /**
   * Cancel an active or pending job.
   */
  cancelJob(jobId, reason = "Cancelled by user") {
    // 1. Check pending queue
    const pendingIdx = this.pendingQueue.findIndex((j) => j.id === jobId);
    if (pendingIdx !== -1) {
      const [cancelled] = this.pendingQueue.splice(pendingIdx, 1);
      cancelled.status = "cancelled";
      this.stats.totalCancelled++;
      cancelled.reject(new Error(reason));
      return { success: true, state: "cancelled_from_queue" };
    }

    // 2. Check running jobs
    const running = this.runningJobs.get(jobId);
    if (running) {
      running.abortController.abort();
      this.stats.totalCancelled++;
      return { success: true, state: "aborted_running" };
    }

    return { success: false, error: "Job not found" };
  }

  /**
   * Get queue health and capacity snapshot.
   */
  getStatus() {
    return {
      queuedJobs: this.pendingQueue.length,
      runningJobs: this.runningJobs.size,
      maxGlobalConcurrent: MAX_GLOBAL_CONCURRENT,
      maxPerUserConcurrent: MAX_PER_USER_CONCURRENT,
      activeUsers: this.userActiveCounts.size,
      stats: { ...this.stats },
      runningDetails: Array.from(this.runningJobs.values()).map((j) => ({
        id: j.id,
        userId: j.userId,
        runningMs: Date.now() - j.startTime,
        metadata: j.metadata,
      })),
    };
  }
}

export const executionQueue = new ExecutionQueue();
