import test from "node:test";
import assert from "node:assert/strict";
import { buildTaskBatches, executeTaskGraph } from "./taskGraph.js";
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
