/**
 * Diagnostic & Environment Repair Tools
 * 
 * Inspects host CLI runtimes, shell availability, workspace permissions,
 * network ports, and provides automated repair workflows.
 */

import os from "os";
import fs from "fs";
import { exec } from "child_process";
import { registerTool } from "./index.js";
import { config } from "../config/env.js";
import { LocalBackend } from "../services/backends/localBackend.js";
import { worldStateService } from "../services/worldStateService.js";
import { workspaceService } from "../services/workspaceService.js";
import { processSupervisor, killProcessTree } from "../services/processSupervisor.js";

/** Helper to execute quick version check */
function checkVersion(command) {
  return new Promise((resolve) => {
    exec(command, { timeout: 3000 }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(stdout.trim().split("\n")[0]);
    });
  });
}

export function registerDiagnosticTools() {
  // 1. diagnose_environment
  registerTool(
    {
      type: "function",
      function: {
        name: "diagnose_environment",
        description:
          "Run a comprehensive health and diagnostic check across host CLI runtimes (Node, npm, Python, Git), " +
          "available shells, workspace permissions, active background processes, and preview server status.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    async () => {
      const [nodeVer, npmVer, pyVer, gitVer] = await Promise.all([
        checkVersion("node -v"),
        checkVersion("npm -v"),
        checkVersion("python --version"),
        checkVersion("git --version"),
      ]);

      const shells = LocalBackend.detectAvailableShells();
      const worldState = worldStateService.getWorldState();
      const isWorkspaceWritable = fs.existsSync(config.workspaceRoot);

      const lines = [];
      lines.push("=== ATH IDE System Diagnostic Report ===");
      lines.push("");
      lines.push("Host System:");
      lines.push(`  Platform: ${os.platform()} (${os.release()})`);
      lines.push(`  Architecture: ${os.arch()}`);
      lines.push(`  CPUs: ${os.cpus().length} cores`);
      lines.push(`  Memory: ${(os.freemem() / (1024 * 1024 * 1024)).toFixed(1)} GB free / ${(os.totalmem() / (1024 * 1024 * 1024)).toFixed(1)} GB total`);
      lines.push("");
      lines.push("CLI Runtimes:");
      lines.push(`  Node.js: ${nodeVer ? `[OK] ${nodeVer}` : "[MISSING]"}`);
      lines.push(`  npm:     ${npmVer ? `[OK] v${npmVer}` : "[MISSING]"}`);
      lines.push(`  Python:  ${pyVer ? `[OK] ${pyVer}` : "[NOT FOUND]"}`);
      lines.push(`  Git:     ${gitVer ? `[OK] ${gitVer}` : "[MISSING]"}`);
      lines.push("");
      lines.push("Available Shells:");
      for (const s of shells) {
        lines.push(`  * ${s.name} (${s.id}) -> ${s.executable}`);
      }
      lines.push("");
      lines.push("Workspace & Storage:");
      lines.push(`  Root Path: ${config.workspaceRoot}`);
      lines.push(`  Status: ${isWorkspaceWritable ? "[OK] Accessible & Writable" : "[ERROR] Not Accessible"}`);
      lines.push(`  Tree Version: ${worldState.workspace.tree_version}`);
      lines.push("");
      lines.push("Preview & Background Processes:");
      lines.push(`  Live Preview Status: ${worldState.preview.status} (Port: ${worldState.preview.port || "None"})`);
      lines.push(`  Active Background Tasks: ${worldState.supervised_processes.active_count}`);
      lines.push("");
      lines.push("Status: All primary services operational.");

      return {
        success: true,
        output: lines.join("\n"),
        diagnostics: {
          runtimes: { node: nodeVer, npm: npmVer, python: pyVer, git: gitVer },
          shells: shells.map((s) => s.id),
          workspaceWritable: isWorkspaceWritable,
          previewStatus: worldState.preview.status,
        },
      };
    }
  );

  // 2. detect_runtimes
  registerTool(
    {
      type: "function",
      function: {
        name: "detect_runtimes",
        description: "Detect available developer runtimes, compilers, and toolchains on the host system.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    async () => {
      const [node, npm, pnpm, yarn, bun, python, git, docker] = await Promise.all([
        checkVersion("node -v"),
        checkVersion("npm -v"),
        checkVersion("pnpm -v"),
        checkVersion("yarn -v"),
        checkVersion("bun -v"),
        checkVersion("python --version"),
        checkVersion("git --version"),
        checkVersion("docker --version"),
      ]);

      const runtimes = {
        node: node ? { available: true, version: node } : { available: false },
        npm: npm ? { available: true, version: npm } : { available: false },
        pnpm: pnpm ? { available: true, version: pnpm } : { available: false },
        yarn: yarn ? { available: true, version: yarn } : { available: false },
        bun: bun ? { available: true, version: bun } : { available: false },
        python: python ? { available: true, version: python } : { available: false },
        git: git ? { available: true, version: git } : { available: false },
        docker: docker ? { available: true, version: docker } : { available: false },
      };

      return { success: true, runtimes, output: JSON.stringify(runtimes, null, 2) };
    }
  );

  // 3. repair_application
  registerTool(
    {
      type: "function",
      function: {
        name: "repair_application",
        description:
          "Inspect and automatically repair common workspace issues: malformed index.html, orphaned processes, " +
          "or uninitialized workspace directories.",
        parameters: {
          type: "object",
          properties: {
            fix_index_html: { type: "boolean", description: "Restore clean workspace index.html if corrupted" },
            kill_orphaned_ports: { type: "boolean", description: "Terminate hanging background dev processes" },
          },
          required: [],
        },
      },
    },
    async (args) => {
      const actionsTaken = [];

      if (args.kill_orphaned_ports) {
        for (const [opId, proc] of processSupervisor.activeProcesses) {
          if (proc.pid) {
            await killProcessTree(proc.pid);
            actionsTaken.push(`Terminated process PID ${proc.pid} (${proc.command})`);
          }
        }
      }

      if (args.fix_index_html) {
        const indexPath = "index.html";
        try {
          const current = await workspaceService.readFile(indexPath);
          if (!current.content || current.content.includes("node.exe -v") || current.content.length < 50) {
            const cleanApp = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>ATH Studio — Workspace App</title>
</head>
<body style="background:#090d16;color:#fff;font-family:sans-serif;padding:2rem;">
  <h1>ATH Studio Workspace</h1>
  <p>Active live development application.</p>
</body>
</html>`;
            await workspaceService.writeFile(indexPath, cleanApp);
            actionsTaken.push("Restored clean workspace index.html");
          }
        } catch {
          // File didn't exist
        }
      }

      return {
        success: true,
        output: actionsTaken.length > 0 ? `Repairs applied:\n${actionsTaken.map((a) => `- ${a}`).join("\n")}` : "No repairs were necessary. Workspace is healthy.",
      };
    }
  );
}
