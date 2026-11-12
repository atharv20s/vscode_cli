import os from "os";
import crypto from "crypto";
import { config, validateConfig } from "../config/env.js";
import { initDatabase, closeDatabase } from "../db/database.js";
import { initPostgres, getPostgresPool } from "../db/postgres.js";
import { initializeTools } from "../tools/index.js";
import { repoAgentQueue } from "../services/repoAgentQueue.js";
import { processRepoAgentTask } from "../services/repoAgentService.js";
import { getRepoTask, updateRepoTask, appendRepoTaskEvent } from "../db/repoAgentStore.js";
import { logger } from "../config/logger.js";

const WORKER_ID = "repo-agent-" + os.hostname() + "-" + process.pid + "-" + crypto.randomUUID().slice(0,8);
const LEASE_MS = Number(process.env.REPO_AGENT_LEASE_MS || 120000);
const MAX_ATTEMPTS = Number(process.env.REPO_AGENT_MAX_ATTEMPTS || 3);
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));

async function bootDatabase() {
  if (config.databaseUrl) await initPostgres(config.databaseUrl);
  initDatabase();
}

async function consumeMessage(message) {
  if (!message.taskId) {
    await repoAgentQueue.ack(message.id);
    return;
  }
  const lease = await repoAgentQueue.acquireLease(message.taskId,LEASE_MS);
  if (!lease) return;

  const controller = new AbortController();
  let lostLease = false;
  let cancellationTimer = null;
  let heartbeatTimer = null;

  const heartbeat = async () => {
    try {
      const renewed = await repoAgentQueue.renewLease(message.taskId,lease,LEASE_MS);
      if (!renewed) {
        lostLease = true;
        controller.abort();
      }
    } catch (error) {
      logger.error("Repository worker lease renewal failed", { taskId:message.taskId,error:error.message });
      lostLease = true;
      controller.abort();
    }
  };

  const checkCancellation = async () => {
    try {
      const task = await getRepoTask(message.taskId);
      const redisCancelled = await repoAgentQueue.isCancellationRequested(message.taskId);
      if (!task || task.cancel_requested || redisCancelled) controller.abort();
    } catch (error) {
      logger.warn("Repository task cancellation poll failed", { taskId:message.taskId,error:error.message });
    }
  };

  heartbeatTimer = setInterval(heartbeat,Math.max(5000,Math.floor(LEASE_MS/3)));
  cancellationTimer = setInterval(checkCancellation,2000);

  try {
    const task = await getRepoTask(message.taskId);
    if (!task) {
      await repoAgentQueue.ack(message.id);
      return;
    }
    if (["review_ready","completed_no_changes","cancelled"].includes(task.status)) {
      await repoAgentQueue.ack(message.id);
      return;
    }
    if (task.cancel_requested) {
      await updateRepoTask(message.taskId,{status:"cancelled"});
      await appendRepoTaskEvent(message.taskId,{type:"status",data:{status:"cancelled"}});
      await repoAgentQueue.ack(message.id);
      return;
    }

    await updateRepoTask(message.taskId,{
      status:"cloning",
      worker_id:WORKER_ID,
      attempt_count:Math.max(task.attempt_count || 0,message.attempt || 0),
      lease_expires_at:new Date(Date.now()+LEASE_MS).toISOString(),
      error:null,
    });
    await appendRepoTaskEvent(message.taskId,{
      type:"worker_claimed",
      data:{workerId:WORKER_ID,attempt:message.attempt || 0},
    });

    const result = await processRepoAgentTask(message.taskId,{
      workerId:WORKER_ID,
      signal:controller.signal,
    });
    const latest = await getRepoTask(message.taskId);

    if (controller.signal.aborted || latest?.cancel_requested) {
      await updateRepoTask(message.taskId,{status:"cancelled"});
      await appendRepoTaskEvent(message.taskId,{type:"status",data:{status:"cancelled"}});
      await repoAgentQueue.ack(message.id);
      await repoAgentQueue.clearCancellation(message.taskId);
      return;
    }

    if (result?.retryable === false || latest?.status === "failed") {
      await appendRepoTaskEvent(message.taskId,{
        type:"worker_final_failure",
        data:{message:latest?.error || "Quality gate failed; no PR was created."},
      });
      await repoAgentQueue.ack(message.id);
      return;
    }
    await repoAgentQueue.ack(message.id);
  } catch (error) {
    logger.error("Repository agent worker task failed",{
      taskId:message.taskId,workerId:WORKER_ID,attempt:message.attempt,error:error.message,
    });
    const latest = await getRepoTask(message.taskId).catch(()=>null);
    if (controller.signal.aborted || latest?.cancel_requested) {
      await updateRepoTask(message.taskId,{status:"cancelled",error:"Task cancelled."}).catch(()=>{});
      await repoAgentQueue.ack(message.id);
    } else if ((message.attempt || 0) + 1 < MAX_ATTEMPTS && !lostLease) {
      const nextAttempt = (message.attempt || 0) + 1;
      await updateRepoTask(message.taskId,{status:"queued",error:error.message,worker_id:null,lease_expires_at:null});
      await appendRepoTaskEvent(message.taskId,{
        type:"retry_scheduled",
        data:{attempt:nextAttempt,maxAttempts:MAX_ATTEMPTS,error:error.message},
      });
      await sleep(Math.min(1000 * (2 ** nextAttempt),10000));
      await repoAgentQueue.enqueue(message.taskId,nextAttempt);
      await repoAgentQueue.ack(message.id);
    } else {
      await updateRepoTask(message.taskId,{status:"failed",error:error.message,worker_id:null,lease_expires_at:null}).catch(()=>{});
      await appendRepoTaskEvent(message.taskId,{type:"error",data:{message:error.message}}).catch(()=>{});
      await repoAgentQueue.ack(message.id);
    }
  } finally {
    clearInterval(heartbeatTimer);
    clearInterval(cancellationTimer);
    await repoAgentQueue.releaseLease(message.taskId,lease).catch(()=>{});
  }
}

async function main() {
  const { errors } = validateConfig();
  if (errors.length) throw new Error("Worker configuration invalid: " + errors.join("; "));
  if (config.executionRuntime !== "docker") {
    throw new Error("Repository queue worker requires EXECUTION_RUNTIME=docker on a dedicated host with Docker Engine.");
  }
  if (!config.redisUrl) throw new Error("REDIS_URL is required for the repository queue worker.");
  await bootDatabase();
  initializeTools();
  await repoAgentQueue.connect();

  logger.info("Repository agent worker started",{
    workerId:WORKER_ID,
    stream:repoAgentQueue.streamName,
    executionRuntime:config.executionRuntime,
  });

  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGINT",stop);
  process.on("SIGTERM",stop);

  while (!stopping) {
    let messages = [];
    try {
      messages = await repoAgentQueue.reclaim(WORKER_ID,60000);
      if (!messages.length) messages = await repoAgentQueue.read(WORKER_ID,5000);
      if (messages.length) await consumeMessage(messages[0]);
    } catch (error) {
      logger.error("Repository agent queue loop failed",{workerId:WORKER_ID,error:error.message});
      await sleep(2000);
    }
  }

  await repoAgentQueue.close();
  if (getPostgresPool()) await getPostgresPool().end().catch(()=>{});
  closeDatabase();
  logger.info("Repository agent worker stopped",{workerId:WORKER_ID});
}

main().catch(error=>{
  logger.error("Repository worker failed to start",{error:error.message});
  process.exitCode=1;
});
