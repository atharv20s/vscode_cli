import test from "node:test";
import assert from "node:assert/strict";
import { selectSkills, formatSkills, skillCatalog, parseSkillFrontmatter, discoverSkillCatalog } from "./skillRegistry.js";

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

test("formatSkills marks imported skill text as untrusted guidance", async () => {
  const formatted = formatSkills(await selectSkills("deploy a Docker app"));
  assert.match(formatted, /Retrieved engineering skills/);
  assert.match(formatted, /docker-deployment/);
  assert.match(formatted, /untrusted engineering reference material/);
});

test("parses Agent Skills frontmatter and rejects invalid metadata", () => {
  assert.deepEqual(parseSkillFrontmatter("---\nname: python-engineering\ndescription: Python async and pytest practices.\nlicense: MIT\n---\n# Python"), {
    name: "python-engineering", description: "Python async and pytest practices."
  });
  assert.equal(parseSkillFrontmatter("# no frontmatter"), null);
  assert.equal(parseSkillFrontmatter("---\nname: ../escape\ndescription: bad\n---\n"), null);
  assert.equal(parseSkillFrontmatter("---\nname: missing-description\n---\n"), null);
});

test("discovers existing on-disk skills without a hard-coded catalog entry", async () => {
  const catalog = await discoverSkillCatalog();
  assert.ok(catalog.some(skill => skill.id === "application-planning"));
  assert.ok(catalog.some(skill => skill.id === "security-review"));
});
