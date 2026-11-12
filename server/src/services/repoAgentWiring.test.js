import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const readSource = relative => fs.readFile(path.resolve(here, relative), "utf8");

test("GitHub task routes wire the repository task and share controllers", async () => {
  const routes = await readSource("../routes/githubRoutes.js");
  const controller = await readSource("../controllers/githubController.js");
  const shareController = await readSource("../controllers/repoAgentShareController.js");

  assert.match(routes, /createRepositoryAgentTask/);
  assert.match(routes, /getRepositoryAgentTask/);
  assert.match(routes, /cancelRepositoryAgentTask/);
  assert.match(routes, /createTaskShare/);
  assert.match(routes, /submitSharedTaskInstruction/);
  assert.match(controller, /export async function createRepositoryAgentTask/);
  assert.match(controller, /export async function getRepositoryAgentTask/);
  assert.match(controller, /export async function cancelRepositoryAgentTask/);
  assert.match(shareController, /export async function createTaskShare/);
  assert.match(shareController, /export async function submitSharedTaskInstruction/);
});
