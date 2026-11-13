import test from "node:test";
import assert from "node:assert/strict";
import { buildTaskBatches, executeTaskGraph, executeTaskGraphDynamic } from "./taskGraph.js";
test("builds stable dependency-aware batches", () => {
  const batches=buildTaskBatches([{id:"api",description:"API"},{id:"ui",description:"UI"},{id:"integration",description:"Integrate",dependsOn:["api","ui"]},{id:"docs",description:"Docs"}]);
  assert.deepEqual(batches.map(batch=>batch.map(task=>task.id)),[["api","ui","docs"],["integration"]]);
});
test("rejects duplicate, unknown and cyclic dependencies", () => {
  assert.throws(()=>buildTaskBatches([{id:"x",description:"x"},{id:"x",description:"dup"}]),/Duplicate/);
  assert.throws(()=>buildTaskBatches([{id:"x",description:"x",dependsOn:["missing"]}]),/unknown/);
  assert.throws(()=>buildTaskBatches([{id:"x",description:"x",dependsOn:["y"]},{id:"y",description:"y",dependsOn:["x"]}]),/cycle/);
});
test("executes prerequisites before dependents and passes prior results", async () => {
  const seen=[];
  const batchesSeen = [];
  const result=await executeTaskGraph(
    [{id:"a",description:"A"},{id:"b",description:"B"},{id:"c",description:"C",dependsOn:["a","b"]}],
    async(task,prior)=>{seen.push(task.id);return task.id==="c"?prior.a+prior.b:task.id;},
    {
      maxConcurrency:2,
      afterBatch: async (batch) => { batchesSeen.push(batch.map(t => t.id)); },
    }
  );
  assert.deepEqual(seen,["a","b","c"]);
  assert.equal(result.results.c,"ab");
  assert.deepEqual(batchesSeen, [["a","b"],["c"]]);
});

test("integrates a completed dependency batch before scheduling dependents", async () => {
  const order=[];
  const result=await executeTaskGraph([
    {id:"a",description:"A"},
    {id:"b",description:"B"},
    {id:"c",description:"C",dependsOn:["a","b"]},
  ],async task=>{order.push("run:"+task.id);return task.id;},{
    maxConcurrency:2,
    afterBatch:async batch=>{order.push("merge:"+batch.map(x=>x.id).join(","));},
  });
  assert.deepEqual(order,["run:a","run:b","merge:a,b","run:c","merge:c"]);
  assert.equal(result.results.c,"c");
});


test("dynamic scheduler starts independent work and releases dependents without waiting for unrelated tasks", async () => {
  const events = [];
  let releaseSlow;
  const slowGate = new Promise(resolve => { releaseSlow = resolve; });
  const resultPromise = executeTaskGraphDynamic([
    {id:"slow",description:"Slow independent task"},
    {id:"fast",description:"Fast independent task"},
    {id:"dependent",description:"Depends only on fast",dependsOn:["fast"]},
  ], async task => {
    events.push("start:"+task.id);
    if (task.id === "slow") await slowGate;
    events.push("finish:"+task.id);
    return task.id;
  }, {
    maxConcurrency:2,
    afterTask: async task => { events.push("integrate:"+task.id); },
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events.slice(0,2),["start:slow","start:fast"]);
  // Fast is integrated and its dependent can start while slow is still running.
  for (let attempt=0;attempt<20 && !events.includes("start:dependent");attempt++) {
    await new Promise(resolve=>setImmediate(resolve));
  }
  assert.ok(events.includes("start:dependent"));
  assert.ok(!events.includes("finish:slow"));
  releaseSlow();
  const result = await resultPromise;
  assert.deepEqual(result.order.length,3);
  assert.equal(result.results.dependent,"dependent");
  assert.ok(events.indexOf("integrate:fast") < events.indexOf("start:dependent"));
});

test("dynamic scheduler rejects cycles before invoking executors", async () => {
  let invoked = false;
  await assert.rejects(
    executeTaskGraphDynamic([
      {id:"a",description:"A",dependsOn:["b"]},
      {id:"b",description:"B",dependsOn:["a"]},
    ], async () => { invoked=true; }),
    /cycle/
  );
  assert.equal(invoked,false);
});
