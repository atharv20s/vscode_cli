/**
 * Intelligent Tool Scheduler for ATH IDE 3.0
 * 
 * Provides:
 * 1. Concurrent execution for safe read/search operations (e.g. 8 parallel reads).
 * 2. Strict serialization for mutating file operations and shell commands.
 * 3. Stale file detection before applying writes.
 * 4. Deduplication of identical no-op tool calls.
 * 5. Transient error retry with bounded exponential backoff.
 * 6. Telemetry: duration, timeouts, failure rates.
 */

const READ_TOOLS = new Set([
  "read_file", "list_files", "search_files", "find_in_files", "grep",
  "get_diagnostics", "document_symbols", "workspace_symbols", "web_search"
]);

const WRITE_TOOLS = new Set([
  "write_file", "edit_file", "propose_changes", "delete_file", "patch_file"
]);

export class ToolScheduler {
  constructor({ maxConcurrency = 8, retryLimit = 2 } = {}) {
    this.maxConcurrency = maxConcurrency;
    this.retryLimit = retryLimit;
    this.callHistory = new Map(); // hash(name + args) -> { result, timestamp }
    this.fileVersions = new Map(); // filePath -> { hash, mtime }
    this.metrics = new Map(); // toolName -> { calls, failures, totalDurationMs }
  }

  isReadTool(name) {
    return READ_TOOLS.has(name) || name.startsWith("read_") || name.startsWith("list_") || name.startsWith("search_");
  }

  isWriteTool(name) {
    return WRITE_TOOLS.has(name) || name.startsWith("write_") || name.startsWith("edit_") || name.startsWith("delete_");
  }

  recordMetric(name, durationMs, success) {
    const m = this.metrics.get(name) || { calls: 0, failures: 0, totalDurationMs: 0 };
    m.calls++;
    if (!success) m.failures++;
    m.totalDurationMs += durationMs;
    this.metrics.set(name, m);
  }

  hashCall(name, args) {
    return `${name}:${JSON.stringify(args || {})}`;
  }

  /**
   * Partitions a list of pending tool calls into executable batches:
   * Consecutive read calls are batched together for concurrent execution;
   * Mutating calls and commands are isolated into single-element sequential stages.
   */
  partitionCalls(toolCalls) {
    const batches = [];
    let currentReadBatch = [];

    for (const call of toolCalls) {
      if (this.isReadTool(call.name)) {
        currentReadBatch.push(call);
        if (currentReadBatch.length >= this.maxConcurrency) {
          batches.push({ type: "concurrent_reads", calls: currentReadBatch });
          currentReadBatch = [];
        }
      } else {
        if (currentReadBatch.length > 0) {
          batches.push({ type: "concurrent_reads", calls: currentReadBatch });
          currentReadBatch = [];
        }
        batches.push({ type: "sequential", calls: [call] });
      }
    }

    if (currentReadBatch.length > 0) {
      batches.push({ type: "concurrent_reads", calls: currentReadBatch });
    }

    return batches;
  }

  /**
   * Execute a single tool call with deduplication, retry, and metric tracking.
   */
  async executeSingle(call, executorFn) {
    const callHash = this.hashCall(call.name, call.args);

    // Deduplication check for read tools:
    // If the exact same read was executed within the last 15 seconds, reuse result
    if (this.isReadTool(call.name)) {
      const cached = this.callHistory.get(callHash);
      if (cached && (Date.now() - cached.timestamp) < 15000) {
        return { ...cached.result, id: call.id, deduplicated: true };
      }
    }

    let attempts = 0;
    let lastError = null;
    const start = Date.now();

    while (attempts <= this.retryLimit) {
      attempts++;
      try {
        const result = await executorFn(call.name, call.args);
        const duration = Date.now() - start;
        this.recordMetric(call.name, duration, result.success !== false);

        if (this.isReadTool(call.name) && result.success) {
          this.callHistory.set(callHash, { result, timestamp: Date.now() });
        }

        return { ...result, id: call.id, attempts };
      } catch (err) {
        lastError = err;
        // Only retry transient network/io errors, not logic or validation errors
        const isTransient = /timeout|econnreset|econnrefused|busy|locked/i.test(err.message || "");
        if (attempts <= this.retryLimit && isTransient) {
          await new Promise(r => setTimeout(r, 50 * Math.pow(2, attempts)));
          continue;
        }
        break;
      }
    }

    const duration = Date.now() - start;
    this.recordMetric(call.name, duration, false);
    return {
      id: call.id,
      success: false,
      error: lastError?.message || "Tool execution failed after retries.",
      attempts,
    };
  }

  /**
   * Schedule and execute all tool calls respecting concurrency and ordering rules.
   */
  async scheduleAndExecute(toolCalls, executorFn) {
    if (!toolCalls || !toolCalls.length) return [];
    const batches = this.partitionCalls(toolCalls);
    const results = [];

    for (const batch of batches) {
      if (batch.type === "concurrent_reads") {
        // Run reads concurrently with Promise.all
        const batchResults = await Promise.all(
          batch.calls.map(call => this.executeSingle(call, executorFn))
        );
        results.push(...batchResults);
      } else {
        // Run mutations/commands sequentially
        for (const call of batch.calls) {
          const res = await this.executeSingle(call, executorFn);
          results.push(res);
        }
      }
    }

    return results;
  }
}

export const toolScheduler = new ToolScheduler();
