import os from "node:os";
import path from "node:path";
import { readFile, readlink } from "node:fs/promises";

const NAMESPACES = ["cgroup", "ipc", "mnt", "net", "pid", "user", "uts"];

export function parseCgroupMembership(contents = "") {
  const entries = [];
  for (const line of String(contents).split(/\r?\n/)) {
    const parts = line.split(":");
    if (parts.length < 3) continue;
    entries.push({ hierarchy: parts[0], controllers: parts[1] ? parts[1].split(",").filter(Boolean) : [], path: parts.slice(2).join(":") || "/" });
  }
  return entries;
}

export function parseCpuMax(contents = "") {
  const [quota, period] = String(contents).trim().split(/\s+/);
  if (!quota || quota === "max") return null;
  const q = Number(quota);
  const p = Number(period);
  if (!Number.isFinite(q) || !Number.isFinite(p) || q <= 0 || p <= 0) return null;
  return Math.round((q / p) * 1000) / 1000;
}

export function parseByteLimit(contents = "") {
  const value = String(contents).trim();
  if (!value || value === "max") return null;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

async function readText(file, fallback = "") {
  try { return await readFile(file, "utf8"); } catch { return fallback; }
}

async function exists(file) {
  try { await readlink(file); return true; } catch { return false; }
}

function resolveCgroupPath(root, membershipPath) {
  const relative = String(membershipPath || "/").replace(/^\/+/, "");
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, relative);
  return candidate === resolvedRoot || candidate.startsWith(resolvedRoot + path.sep) ? candidate : resolvedRoot;
}

/**
 * Return process-scoped Linux runtime facts from procfs and cgroupfs.
 * No shell commands, privileged operations, host identifiers or secret values
 * are read. Non-Linux hosts return a stable unsupported response.
 */
export async function getLinuxRuntimeDiagnostics(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "linux") {
    return { supported: false, platform, reason: "Linux runtime diagnostics require a Linux worker." };
  }

  const procRoot = options.procRoot || "/proc";
  const cgroupRoot = options.cgroupRoot || "/sys/fs/cgroup";
  const [release, status, membershipText, controllers] = await Promise.all([
    readText(path.join(procRoot, "sys/kernel/osrelease"), "unknown"),
    readText(path.join(procRoot, "self/status"), ""),
    readText(path.join(procRoot, "self/cgroup"), ""),
    readText(path.join(cgroupRoot, "cgroup.controllers"), ""),
  ]);
  const membership = parseCgroupMembership(membershipText);
  const unified = membership.find(entry => entry.hierarchy === "0" && entry.controllers.length === 0);
  const cgroupVersion = unified || controllers.trim() ? 2 : membership.length ? 1 : 0;
  const processCgroup = unified?.path || membership[0]?.path || "/";
  const cgroupPath = resolveCgroupPath(cgroupRoot, processCgroup);
  const [memoryMax, cpuMax, pidsMax, namespaceEntries] = await Promise.all([
    readText(path.join(cgroupPath, "memory.max"), ""),
    readText(path.join(cgroupPath, "cpu.max"), ""),
    readText(path.join(cgroupPath, "pids.max"), ""),
    Promise.all(NAMESPACES.map(async name => [name, await exists(path.join(procRoot, "self/ns", name))])),
  ]);
  const statusValue = key => {
    const match = status.match(new RegExp("^" + key + ":\\s*(\\d+)", "m"));
    return match ? Number(match[1]) : null;
  };
  const pidsLimit = pidsMax.trim() === "max" ? null : Number.isSafeInteger(Number(pidsMax.trim())) ? Number(pidsMax.trim()) : null;

  return {
    supported: true,
    platform,
    kernel: { release: release.trim(), architecture: os.arch() },
    runtime: { node: process.version, pid: process.pid },
    isolation: {
      cgroupVersion,
      namespaces: Object.fromEntries(namespaceEntries),
      seccompMode: statusValue("Seccomp"),
      noNewPrivileges: statusValue("NoNewPrivs") === 1,
    },
    limits: {
      memoryBytes: cgroupVersion === 2 ? parseByteLimit(memoryMax) : null,
      cpuCores: cgroupVersion === 2 ? parseCpuMax(cpuMax) : null,
      processCount: pidsLimit,
    },
  };
}
