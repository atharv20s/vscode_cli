import test from "node:test";
import assert from "node:assert/strict";
import { selectSkills, formatSkills, skillCatalog } from "./skillRegistry.js";

test("skill registry selects relevant engineering guidance", async () => {
  const skills = await selectSkills("Build a React frontend with a PostgreSQL database and debug tests");
  const ids = skills.map(skill => skill.id);
  assert.ok(ids.includes("react-nextjs"));
  assert.ok(ids.includes("postgresql"));
  assert.ok(ids.includes("debugging-testing"));
  assert.ok(skills.length <= 4);
});

test("skill selection is bounded and ignores unrelated prompts", async () => {
  assert.deepEqual(await selectSkills("hello there"), []);
  assert.deepEqual(await selectSkills("build a React app", { limit: 0 }), []);
  assert.ok(skillCatalog.length >= 7);
});

test("formatSkills produces explicit skill context", async () => {
  const skills = await selectSkills("deploy a Docker app");
  const formatted = formatSkills(skills);
  assert.match(formatted, /Retrieved engineering skills/);
  assert.match(formatted, /docker-deployment/);
});
