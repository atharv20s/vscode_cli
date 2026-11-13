/**
 * Dependency-aware task graph primitives.
 * Tasks are scheduled in stable topological batches; callers decide whether
 * tasks in a batch have isolated workspaces suitable for parallel execution.
 */
export function normalizeTaskGraph(input) {
  if (!Array.isArray(input) || input.length === 0) throw new Error("Task graph must contain at least one task.");
  const ids = new Set();
  const tasks = input.map((item, index) => {
    const id = String(item?.id || "").trim();
    const description = String(item?.description || item?.task || "").trim();
    if (!id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error("Task " + index + " has an invalid id.");
    if (ids.has(id)) throw new Error("Duplicate task id: " + id);
    if (!description) throw new Error("Task " + id + " requires a description.");
    ids.add(id);
    const dependsOn = Array.isArray(item.dependsOn) ? [...new Set(item.dependsOn.map(String))] : [];
    return { id, description, role: String(item.role || "coder"), dependsOn };
  });
  for (const task of tasks) for (const dependency of task.dependsOn) {
    if (dependency === task.id) throw new Error("Task " + task.id + " cannot depend on itself.");
    if (!ids.has(dependency)) throw new Error("Task " + task.id + " depends on unknown task " + dependency + ".");
  }
  return tasks;
}
export function buildTaskBatches(input) {
  const tasks = normalizeTaskGraph(input);
  const remaining = new Map(tasks.map(task => [task.id, task]));
  const completed = new Set(), batches = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter(task => task.dependsOn.every(id => completed.has(id)));
    if (!ready.length) throw new Error("Task graph contains a dependency cycle.");
    batches.push(ready);
    for (const task of ready) { completed.add(task.id); remaining.delete(task.id); }
  }
  return batches;
}
export async function executeTaskGraph(input, executor, options = {}) {
  if (typeof executor !== "function") throw new Error("Task graph executor must be a function.");
  const batches = buildTaskBatches(input), results = new Map();
  const maxConcurrency = Math.max(1, Math.min(16, Number(options.maxConcurrency) || 1));
  for (const batch of batches) {
    const batchResults = new Map();
    if (options.signal?.aborted) throw new Error("Task graph cancelled.");
    for (let offset = 0; offset < batch.length; offset += maxConcurrency) {
      const group = batch.slice(offset, offset + maxConcurrency);
      // Wait for every isolated task in this batch to settle before advancing
      // or surfacing a failure. This prevents late writers from racing with a
      // retry/merge phase after Promise.all has already rejected.
      const settled = await Promise.allSettled(group.map(async task => ({
        task,
        result: await executor(task, Object.fromEntries(results)),
      })));
      const failure = settled.find(item => item.status === "rejected");
      if (failure) throw failure.reason;
      for (const item of settled) batchResults.set(item.value.task.id, item.value.result);
    }
    if (typeof options.afterBatch === "function") {
      await options.afterBatch(batch, Object.fromEntries(batchResults), Object.fromEntries(results));
    }
    for (const [id, result] of batchResults) results.set(id, result);
  }
  return { batches:batches.map(batch=>batch.map(task=>task.id)), results:Object.fromEntries(results) };
}

/**
 * Schedule ready DAG nodes as soon as their own prerequisites have completed.
 * afterTask runs before dependents are released, allowing callers to integrate
 * an isolated worktree before a dependent task branches from the new HEAD.
 */
export async function executeTaskGraphDynamic(input, executor, options = {}) {
  if (typeof executor !== "function") throw new Error("Task graph executor must be a function.");
  const tasks = normalizeTaskGraph(input);
  const maxConcurrency = Math.max(1, Math.min(16, Number(options.maxConcurrency) || 1));
  const byId = new Map(tasks.map(task => [task.id, task]));
  const order = new Map(tasks.map((task, index) => [task.id, index]));
  const dependents = new Map(tasks.map(task => [task.id, []]));
  const remainingDependencies = new Map(tasks.map(task => [task.id, task.dependsOn.length]));
  for (const task of tasks) for (const dependency of task.dependsOn) dependents.get(dependency).push(task.id);

  // Validate cycles before starting any side-effecting executor.
  buildTaskBatches(tasks);
  const ready = tasks.filter(task => remainingDependencies.get(task.id) === 0);
  const running = new Map();
  const results = new Map();
  const scheduled = new Set();
  const completedOrder = [];

  while (results.size < tasks.length) {
    if (options.signal?.aborted) {
      await Promise.allSettled([...running.values()]);
      throw new Error("Task graph cancelled.");
    }

    ready.sort((a, b) => order.get(a.id) - order.get(b.id));
    while (ready.length && running.size < maxConcurrency) {
      const task = ready.shift();
      if (scheduled.has(task.id)) continue;
      scheduled.add(task.id);
      const prior = Object.fromEntries(results);
      const promise = Promise.resolve().then(async () => ({
        task,
        result: await executor(task, prior),
      }));
      running.set(task.id, promise);
    }

    if (!running.size) throw new Error("Task graph stalled before all tasks completed.");
    const settled = await Promise.race([...running.entries()].map(([id, promise]) =>
      promise.then(value => ({ id, value }), error => ({ id, error }))
    ));
    running.delete(settled.id);
    if (settled.error) {
      await Promise.allSettled([...running.values()]);
      throw settled.error;
    }

    const { task, result } = settled.value;
    if (typeof options.afterTask === "function") {
      try {
        await options.afterTask(task, result, Object.fromEntries(results));
      } catch (error) {
        // Do not leave sibling agents running after an integration failure.
        await Promise.allSettled([...running.values()]);
        throw error;
      }
    }
    results.set(task.id, result);
    completedOrder.push(task.id);

    for (const dependentId of dependents.get(task.id)) {
      const count = remainingDependencies.get(dependentId) - 1;
      remainingDependencies.set(dependentId, count);
      if (count === 0) ready.push(byId.get(dependentId));
    }
  }

  return {
    order: completedOrder,
    results: Object.fromEntries(results),
  };
}
