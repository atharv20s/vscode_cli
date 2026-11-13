import test from "node:test";
import { createServer } from "node:http";
import { clearTools, executeTool, initializeTools } from "./index.js";
import assert from "node:assert/strict";
import { isPreviewVerificationUrl } from "./browserVerificationTools.js";

test("browser verification only accepts local or preview hostnames", () => {
  assert.equal(isPreviewVerificationUrl("http://localhost:5173").ok, true);
  assert.equal(isPreviewVerificationUrl("http://127.0.0.1:3000").ok, true);
  assert.equal(isPreviewVerificationUrl("https://169.254.169.254/latest/meta-data").ok, false);
  assert.equal(isPreviewVerificationUrl("https://example.com").ok, false);
  assert.equal(isPreviewVerificationUrl("file:///etc/passwd").ok, false);
});


test("browser_verify runs a real Playwright session and exercises preview interactions", async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, {"content-type":"text/html; charset=utf-8"});
    response.end(`<!doctype html><html><head><title>ATH Preview E2E</title></head><body>
      <label for="task">Task</label><input id="task" aria-label="Task">
      <button type="button" id="run">Run task</button>
      <p id="status" aria-live="polite">Ready</p>
      <script>document.querySelector("#run").addEventListener("click",()=>{document.querySelector("#status").textContent=document.querySelector("#task").value ? "Task queued" : "Enter a task";});</script>
    </body></html>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const url = "http://127.0.0.1:" + address.port + "/";
  try {
    clearTools();
    initializeTools();
    const result = await executeTool("browser_verify", {
      url,
      actions: [
        {role:"textbox",name:"Task",value:"verify workspace"},
        {role:"button",name:"Run task"},
      ],
      timeout_ms:10000,
    });
    assert.equal(result.verified, true, result.error);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.status, 200);
    assert.equal(result.title, "ATH Preview E2E");
    assert.equal(result.actions.length, 2);
    assert.ok(result.screenshotBase64.length > 1000);
  } finally {
    clearTools();
    await new Promise(resolve => server.close(resolve));
  }
});
