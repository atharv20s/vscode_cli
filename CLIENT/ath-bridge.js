#!/usr/bin/env node
/**
 * ATH IDE -- Hybrid Workstation Bridge Daemon
 * 
 * Bridges a local PC (Windows / macOS / Linux) to an ATH IDE Cloud instance.
 * Allows the cloud-hosted AI agent to seamlessly execute commands on the
 * user's physical machine and report local telemetry (installed runtimes,
 * shell environments, GPU/CPU metrics) back to the Cloud IDE.
 */

import os from "os";
import { spawn, exec } from "child_process";
import WebSocket from "ws";

// Parse CLI Arguments
const args = process.argv.slice(2);
let serverUrl = "http://localhost:3001";
let authToken = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--server" || args[i] === "-s") {
    serverUrl = args[++i];
  } else if (args[i] === "--token" || args[i] === "-t") {
    authToken = args[++i];
  }
}

// Convert HTTP to WS URL
const wsUrl = serverUrl.replace(/^http/, "ws") + "/ws";
const clientName = `${os.userInfo().username}@${os.hostname()} (${os.platform()} ${os.arch()})`;

console.log("==========================================================================");
console.log(" ATH IDE -- Hybrid Workstation Bridge Daemon");
console.log("==========================================================================");
console.log(`[+] Host Machine:   ${clientName}`);
console.log(`[+] Target Server:  ${serverUrl}`);
console.log(`[+] WebSocket URL:  ${wsUrl}`);
console.log("==========================================================================");

/** Detect local available runtimes */
function detectLocalRuntimes() {
  const runtimes = {
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
    totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
    shells: os.platform() === "win32" ? ["powershell", "cmd", "pwsh", "wsl"] : ["bash", "sh", "zsh"],
  };
  return runtimes;
}

let ws = null;
let reconnectTimer = null;

function connect() {
  console.log("[+] Connecting to ATH Cloud Server...");
  ws = new WebSocket(wsUrl, {
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
  });

  ws.on("open", () => {
    console.log("[+] Connected successfully to ATH Cloud Server!");
    console.log("[+] Registering local workstation node...");

    // Send bridge handshake
    ws.send(
      JSON.stringify({
        type: "bridge.register",
        payload: {
          nodeId: `node_${os.hostname()}_${os.platform()}`,
          name: clientName,
          platform: os.platform(),
          arch: os.arch(),
          runtimes: detectLocalRuntimes(),
          capabilities: ["exec_local", "powershell", "bash", "pty"],
        },
      })
    );
  });

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "bridge.exec") {
        const { operationId, command, cwd, shell = "powershell" } = msg.payload || {};
        console.log(`[+] Received remote execution request [${operationId}]: ${command}`);

        const isWin = os.platform() === "win32";
        let execCmd = command;
        let shellExe = isWin ? "powershell.exe" : "bash";
        let shellArgs = isWin
          ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]
          : ["-c", command];

        const child = spawn(shellExe, shellArgs, {
          cwd: cwd || process.cwd(),
          env: process.env,
        });

        child.stdout.on("data", (data) => {
          ws.send(
            JSON.stringify({
              type: "bridge.output",
              payload: { operationId, data: data.toString(), stream: "stdout" },
            })
          );
        });

        child.stderr.on("data", (data) => {
          ws.send(
            JSON.stringify({
              type: "bridge.output",
              payload: { operationId, data: data.toString(), stream: "stderr" },
            })
          );
        });

        child.on("close", (exitCode) => {
          console.log(`[+] Command [${operationId}] completed (Exit code: ${exitCode})`);
          ws.send(
            JSON.stringify({
              type: "bridge.completed",
              payload: { operationId, exitCode },
            })
          );
        });
      }
    } catch (err) {
      console.error("[-] Error handling message:", err.message);
    }
  });

  ws.on("close", () => {
    console.log("[-] Disconnected from server. Reconnecting in 5 seconds...");
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 5000);
  });

  ws.on("error", (err) => {
    console.error("[-] WebSocket Error:", err.message);
  });
}

connect();
