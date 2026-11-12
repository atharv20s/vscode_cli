import test from "node:test";
import assert from "node:assert/strict";

test("GitHub task routes and controllers load with the current service exports", async () => {
  const routes = await import("../routes/githubRoutes.js");
  assert.ok(routes.default);
  assert.equal(typeof routes.default, "function");
});
