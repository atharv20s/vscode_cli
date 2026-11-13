import fs from "fs/promises";
import path from "path";
import assert from "assert/strict";
import { initializeTools, executeTool, clearTools } from "../server/src/tools/index.js";
import { generatePreviewToken } from "../server/src/middleware/auth.js";
import { config } from "../server/src/config/env.js";

async function main() {
  console.log("=================================================================");
  console.log("ATH IDE Production Acceptance Test on AWS Lightsail Infrastructure");
  console.log("=================================================================");
  console.log("Time:", new Date().toISOString());
  console.log("Public URL:", config.publicUrl);
  console.log("Preview Public URL:", config.previewPublicUrl);
  console.log("Execution Runtime:", config.executionRuntime);
  console.log("Worker URL:", config.executionWorkerUrl);

  const userId = "prod-verifier-user";
  const workspaceKey = "acceptance-ws";
  const workspaceDir = path.resolve(config.workspaceRoot || "/home/ubuntu/ath-ide/workspace");
  const testPort = 4173;

  await fs.mkdir(workspaceDir, { recursive: true });

  // 1. Create test HTML app in workspace
  const htmlContent = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ATH IDE Production Acceptance Test</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem; }
    .card { background: #1e293b; border-radius: 8px; padding: 1.5rem; max-width: 600px; margin: 0 auto; border: 1px solid #334155; }
    h1 { font-size: 1.5rem; color: #38bdf8; margin-top: 0; }
    .badge { display: inline-block; padding: 4px 10px; background: #10b981; color: #022c22; font-weight: bold; border-radius: 4px; font-size: 0.85rem; margin-bottom: 1rem; }
    input { width: 100%; box-sizing: border-box; padding: 0.5rem; border: 1px solid #475569; background: #0f172a; color: #f8fafc; border-radius: 4px; margin: 0.5rem 0 1rem 0; }
    button { background: #2563eb; color: #fff; border: none; padding: 0.6rem 1.2rem; border-radius: 4px; font-weight: 600; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    #result { margin-top: 1rem; padding: 0.75rem; background: #0f172a; border-radius: 4px; border: 1px solid #334155; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge" data-testid="acceptance-badge">AWS Lightsail Live Acceptance</div>
    <h1>ATH IDE Production Acceptance Verification</h1>
    <label for="action-input">Verification Action</label>
    <input id="action-input" aria-label="Verification Action" value="Ready for Verification" />
    <button id="execute-btn" type="button" role="button">Execute Verification</button>
    <div id="result" aria-live="polite">Status: Ready</div>
  </div>
  <script>
    document.getElementById("execute-btn").addEventListener("click", () => {
      const val = document.getElementById("action-input").value;
      document.getElementById("result").textContent = "Status: Interaction Verified (" + val + ")";
      console.log("Production acceptance interaction executed successfully: " + val);
    });
  </script>
</body>
</html>`;

  await fs.writeFile(path.join(workspaceDir, "index.html"), htmlContent, "utf8");
  console.log("\n[Step 2] Wrote test web app to workspace:", path.join(workspaceDir, "index.html"));

  // Initialize tool registry
  clearTools();
  initializeTools();

  const ctx = {
    userId,
    workspaceKey,
    workspaceId: userId + ":" + workspaceKey,
  };

  // 2. Start Preview using previewTools (start_preview)
  console.log("\n[Step 3] Calling start_preview tool...");
  const startResult = await executeTool("start_preview", {
    command: `python3 -m http.server ${testPort}`,
    port: testPort,
  }, ctx);

  console.log("start_preview tool result:", JSON.stringify(startResult, null, 2));
  assert.equal(startResult.success, true, "start_preview failed: " + startResult.error);

  // 3. Wait until preview reports running
  console.log("\n[Step 4] Polling get_preview_status tool...");
  let statusResult;
  for (let i = 0; i < 15; i++) {
    statusResult = await executeTool("get_preview_status", {}, ctx);
    console.log(`  Poll ${i + 1}: status = ${statusResult.state?.status}, url = ${statusResult.state?.url}`);
    if (statusResult.state?.status === "running") break;
    await new Promise(r => setTimeout(r, 1000));
  }

  assert.equal(statusResult.state?.status, "running", "Preview failed to enter running state");
  const previewUrl = statusResult.state.url;
  console.log("Active preview URL:", previewUrl);

  // 4. Use browser_verify against actual preview URL
  console.log("\n[Step 5 & 6] Calling browser_verify tool against actual preview URL...");
  const verifyResult = await executeTool("browser_verify", {
    url: previewUrl,
    actions: [
      { role: "textbox", name: "Verification Action", value: "Production Acceptance Passed Live" },
      { role: "button", name: "Execute Verification" },
    ],
    timeout_ms: 20000,
  }, ctx);

  console.log("browser_verify result summary:");
  console.log("  verified:", verifyResult.verified);
  console.log("  success:", verifyResult.success);
  console.log("  status code:", verifyResult.status);
  console.log("  page title:", verifyResult.title);
  console.log("  console errors:", JSON.stringify(verifyResult.consoleErrors));
  console.log("  page errors:", JSON.stringify(verifyResult.pageErrors));
  console.log("  actions executed:", JSON.stringify(verifyResult.actions, null, 2));

  assert.equal(verifyResult.verified, true, "browser_verify was not verified: " + verifyResult.error);
  assert.equal(verifyResult.success, true, "browser_verify failed: " + JSON.stringify(verifyResult));
  assert.equal(verifyResult.title, "ATH IDE Production Acceptance Test");
  assert.equal(verifyResult.pageErrors.length, 0, "Encountered page errors");
  assert.ok(verifyResult.screenshotBase64 && verifyResult.screenshotBase64.length > 1000, "Screenshot was not captured");

  // Save screenshot to disk
  const screenshotPath = "/tmp/acceptance-preview-screenshot.png";
  await fs.writeFile(screenshotPath, Buffer.from(verifyResult.screenshotBase64, "base64"));
  console.log("  Screenshot saved to:", screenshotPath);

  // 5. Stop preview using stop_preview tool
  console.log("\n[Step 7] Calling stop_preview tool...");
  const stopResult = await executeTool("stop_preview", {}, ctx);
  console.log("stop_preview result:", JSON.stringify(stopResult, null, 2));
  assert.equal(stopResult.success, true, "stop_preview failed: " + stopResult.error);

  // Verify process terminated
  const finalStatus = await executeTool("get_preview_status", {}, ctx);
  console.log("Final preview status:", finalStatus.state?.status);
  assert.equal(finalStatus.state?.status, "stopped", "Preview did not stop cleanly");

  console.log("\n=================================================================");
  console.log("ALL ACCEPTANCE TEST STEPS COMPLETED AND VERIFIED 100% SUCCESSFULLY");
  console.log("=================================================================");
}

main().catch(err => {
  console.error("ACCEPTANCE TEST FAILED:", err);
  process.exit(1);
});

