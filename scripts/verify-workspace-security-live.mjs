#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);
const docker = process.env.DOCKER_BIN || "docker";
const image = process.env.DOCKER_WORKSPACE_IMAGE || "ath-ide-workspace:local";
const profile = path.resolve(process.env.DOCKER_SECCOMP_PROFILE || "/etc/ath-ide/seccomp-workspace.json");
const name = "ath-ide-security-acceptance-" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);

if (process.platform !== "linux") throw new Error("Run this acceptance test on the Linux Docker worker host.");
const stat = await fs.stat(profile).catch(() => null);
if (!stat?.isFile()) throw new Error("Required seccomp profile is missing: " + profile);
await exec(docker, ["info"], { timeout: 15000 });

let containerId = "";
try {
  const created = await exec(docker, [
    "create", "--name", name,
    "--network", "none",
    "--security-opt", "no-new-privileges",
    "--security-opt", "seccomp=" + profile,
    "--read-only",
    "--cap-drop", "ALL",
    "--pids-limit", "64",
    "--memory", "128m",
    "--cpus", "0.5",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
    image,
    "sh", "-c", "grep -E '^(Seccomp|NoNewPrivs):' /proc/self/status",
  ], { timeout: 30000 });
  containerId = created.stdout.trim();
  if (!containerId) throw new Error("Docker did not return a container ID.");

  const inspected = await exec(docker, ["inspect", containerId], { timeout: 15000 });
  const [container] = JSON.parse(inspected.stdout);
  const host = container?.HostConfig || {};
  const securityOptions = Array.isArray(host.SecurityOpt) ? host.SecurityOpt : [];
  const seccompOk = securityOptions.includes("seccomp=" + profile);
  const noNewPrivilegesOk = securityOptions.some(value => value === "no-new-privileges" || value === "no-new-privileges:true");
  const readonlyOk = host.ReadonlyRootfs === true;
  const capabilitiesOk = Array.isArray(host.CapDrop) && host.CapDrop.includes("ALL");
  const networkOk = host.NetworkMode === "none";
  const memoryOk = host.Memory === 134217728;
  const pidsOk = host.PidsLimit === 64;
  const failures = Object.entries({ seccompOk, noNewPrivilegesOk, readonlyOk, capabilitiesOk, networkOk, memoryOk, pidsOk })
    .filter(([, ok]) => !ok).map(([key]) => key);
  if (failures.length) throw new Error("Docker inspect did not match required security baseline: " + failures.join(", "));

  await exec(docker, ["start", "-a", containerId], { timeout: 30000 }).then(result => {
    const output = result.stdout || "";
    if (!/^Seccomp:\s*2\s*$/m.test(output)) throw new Error("Container process did not report seccomp filter mode 2.");
    if (!/^NoNewPrivs:\s*1\s*$/m.test(output)) throw new Error("Container process did not report NoNewPrivs=1.");
    console.log(JSON.stringify({
      success: true,
      test: "docker-workspace-security-acceptance",
      image,
      profile,
      inspected: { seccompOk, noNewPrivilegesOk, readonlyOk, capabilitiesOk, networkOk, memoryOk, pidsOk },
      processStatus: output.trim().split(/\r?\n/),
    }, null, 2));
  });
} finally {
  if (containerId) await exec(docker, ["rm", "-f", containerId], { timeout: 15000 }).catch(() => {});
}
