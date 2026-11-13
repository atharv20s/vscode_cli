import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../");
const fixturePath = path.join(repoRoot, "benchmarks/fixtures/browser-acceptance/index.html");
const benchmarkPath = path.join(repoRoot, "benchmarks/browser-acceptance.mjs");

test("Playwright browser acceptance and visual baseline comparison", {
  skip: process.env.CI !== "true" ? "Runs in CI where Chromium can be provisioned." : false,
  timeout: 180000,
}, async t => {
  const install = spawnSync("npx", ["playwright", "install", "--with-deps", "chromium"], {
    cwd: path.join(repoRoot, "server"),
    encoding: "utf8",
    timeout: 150000,
  });
  assert.equal(install.status, 0, "Playwright Chromium installation failed: " + (install.stderr || install.stdout));

  const html = await fs.readFile(fixturePath);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const baselineDir = await fs.mkdtemp(path.join(os.tmpdir(), "ath-visual-baseline-"));
  const env = {
    ...process.env,
    APP_URL: "http://127.0.0.1:" + address.port + "/",
    VISUAL_BASELINE_DIR: baselineDir,
    VISUAL_BASELINE_NAME: "acceptance",
  };
  const run = update => spawnSync(process.execPath, [benchmarkPath], {
    cwd: path.join(repoRoot, "server"),
    encoding: "utf8",
    timeout: 60000,
    env: update ? { ...env, UPDATE_VISUAL_BASELINES: "1" } : { ...env, UPDATE_VISUAL_BASELINES: "" },
  });
  try {
    const baseline = run(true);
    assert.equal(baseline.status, 0, "Browser baseline capture failed: " + (baseline.stderr || baseline.stdout));
    const comparison = run(false);
    assert.equal(comparison.status, 0, "Browser visual regression comparison failed: " + (comparison.stderr || comparison.stdout));
    assert.match(comparison.stdout, /"type":"visual-diff"/);
    assert.match(comparison.stdout, /"success":true/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(baselineDir, { recursive:true, force:true });
  }
});
