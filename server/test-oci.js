/**
 * Pure JavaScript Oracle Cloud (OCI) Sandbox Diagnostic & Connection Tester
 * 
 * Usage:
 *   cd server
 *   node test-oci.js
 *   node test-oci.js --check-local
 */

import net from "net";
import fs from "fs";
import path from "path";
import { execFile, execSync } from "child_process";
import { config } from "./src/config/env.js";

const host = config.remoteSandbox?.host || process.env.OCI_HOST || process.env.REMOTE_HOST;
const user = config.remoteSandbox?.user || process.env.OCI_USER || "ubuntu";
const keyPath = config.remoteSandbox?.keyPath || process.env.OCI_SSH_KEY_PATH || "";
const port = config.remoteSandbox?.port || parseInt(process.env.OCI_PORT || "22", 10);
const workspace = config.remoteSandbox?.workspace || process.env.OCI_WORKSPACE || "/home/ubuntu/agent-workspace";
const isCheckLocalOnly = process.argv.includes("--check-local");

console.log("======================================================");
console.log("  Node.js Oracle Cloud (OCI) Sandbox Validator        ");
console.log("======================================================");

// 1. Check Local SSH
console.log("\n> Step 1: Checking Local OpenSSH Client");
try {
  const sshVer = execSync("ssh -V", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  console.log(`  [OK] Found OpenSSH client: ${(sshVer || "").trim()}`);
} catch (err) {
  const errOutput = (err.stderr || err.stdout || "").toString().trim();
  if (errOutput.toLowerCase().includes("openssh")) {
    console.log(`  [OK] Found OpenSSH client: ${errOutput}`);
  } else {
    console.error(`  [FAIL] OpenSSH ('ssh') not found on system PATH.`);
    process.exit(1);
  }
}

if (isCheckLocalOnly) {
  console.log("\n[OK] Local OpenSSH check passed!");
  process.exit(0);
}

// 2. Check Key File
console.log("\n> Step 2: Checking SSH Private Key");
if (!keyPath) {
  console.log("  [FAIL] No SSH Key path configured (OCI_SSH_KEY_PATH in .env)");
  console.log("  Configure OCI_SSH_KEY_PATH in your .env file.");
  process.exit(1);
}

const resolvedKey = path.resolve(keyPath);
if (!fs.existsSync(resolvedKey)) {
  console.error(`  [FAIL] SSH Key file does not exist: ${resolvedKey}`);
  console.log("  Ensure your .pem or .key file path is correct.");
  process.exit(1);
}
console.log(`  [OK] SSH Key file found: ${resolvedKey} (${fs.statSync(resolvedKey).size} bytes)`);

// 3. Test TCP Network Socket to OCI VM
console.log(`\n> Step 3: Testing Network Connectivity to ${host}:${port}`);
if (!host || host === "129.146.xxx.xxx") {
  console.error("  [FAIL] OCI_HOST is empty or still placeholder '129.146.xxx.xxx'.");
  console.log("  Please set OCI_HOST to your real Oracle Cloud VM Public IP in .env.");
  process.exit(1);
}

function checkPort(targetHost, targetPort) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(5000);

    socket.on("connect", () => {
      const ms = Date.now() - start;
      socket.destroy();
      resolve({ ok: true, ms });
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolve({ ok: false, error: "Connection timed out (Check OCI Security List port 22 ingress rule)" });
    });

    socket.on("error", (err) => {
      socket.destroy();
      resolve({ ok: false, error: err.message });
    });

    socket.connect(targetPort, targetHost);
  });
}

function runRemoteCommand(cmd) {
  return new Promise((resolve) => {
    const sshExecutable = process.platform === "win32" ? "ssh.exe" : "ssh";
    const args = [
      "-p", String(port),
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
      "-o", "ConnectTimeout=10",
      "-o", "BatchMode=yes",
    ];

    if (keyPath) {
      args.push("-i", resolvedKey);
    }

    args.push(`${user}@${host}`, cmd);

    execFile(sshExecutable, args, { timeout: 20000 }, (error, stdout, stderr) => {
      const output = (stdout || stderr || "").trim();
      resolve({ success: !error, output, exitCode: error ? error.code : 0 });
    });
  });
}

async function main() {
  const netResult = await checkPort(host, port);
  if (!netResult.ok) {
    console.error(`  [FAIL] Cannot connect to ${host}:${port} - ${netResult.error}`);
    process.exit(1);
  }
  console.log(`  [OK] Successfully connected to ${host}:${port} (latency: ${netResult.ms}ms)`);

  // 4. SSH Authentication
  console.log("\n> Step 4: Testing SSH Authentication");
  const authTest = await runRemoteCommand("echo 'OCI_AUTH_SUCCESS'");
  if (!authTest.success || !authTest.output.includes("OCI_AUTH_SUCCESS")) {
    console.error(`  [FAIL] SSH authentication failed for ${user}@${host}`);
    console.error(`  Details: ${authTest.output}`);
    console.log("  Ensure OCI_USER is correct ('ubuntu' for Ubuntu, 'opc' for Oracle Linux).");
    process.exit(1);
  }
  console.log(`  [OK] SSH Authentication successful for user '${user}'!`);

  // 5. Query Specs
  console.log("\n> Step 5: Querying Remote Cloud VM Hardware Specs");
  const specsCmd = "uname -s -r -m; cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2 | tr -d '\"'; nproc; free -h | awk '/^Mem:/ {print $2 \" total, \" $7 \" available\"}'";
  const specsResult = await runRemoteCommand(specsCmd);
  if (specsResult.success) {
    const lines = specsResult.output.split("\n").map(l => l.trim()).filter(Boolean);
    console.log(`  [OK] Kernel: ${lines[0] || 'Linux'}`);
    console.log(`  [OK] OS: ${lines[1] || 'Ubuntu'}`);
    console.log(`  [OK] CPU Cores: ${lines[2] || 'Unknown'} OCPUs`);
    console.log(`  [OK] RAM: ${lines[3] || 'Unknown'}`);
  }

  // 6. Test Workspace Creation
  console.log(`\n> Step 6: Verifying Remote Cloud Workspace Directory (${workspace})`);
  const wsCmd = `mkdir -p '${workspace}' && touch '${workspace}/.node_test' && rm '${workspace}/.node_test' && echo 'WS_OK'`;
  const wsResult = await runRemoteCommand(wsCmd);
  if (wsResult.success && wsResult.output.includes("WS_OK")) {
    console.log(`  [OK] Workspace created and verified: ${workspace}`);
  } else {
    console.error(`  [FAIL] Workspace creation failed: ${wsResult.output}`);
  }

  console.log("\n======================================================");
  console.log(" [SUCCESS] Your Oracle Cloud Node.js Sandbox is Ready! ");
  console.log("======================================================\n");
}

main();
