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
      for (const item of settled) results.set(item.value.task.id, item.value.result);
    }
  }
  return { batches:batches.map(batch=>batch.map(task=>task.id)), results:Object.fromEntries(results) };
}
