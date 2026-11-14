import path from "node:path";
import { readFile } from "node:fs/promises";

function readText(file) {
  return readFile(file, "utf8").catch(() => "");
}

function parseLimit(value) {
  const text = String(value || "").trim();
  if (!text || text === "max") return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function parseCgroupStats(text = "") {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.trim().match(/^([a-zA-Z0-9_]+)\s+(\d+)$/);
    if (match) values[match[1]] = Number(match[2]);
  }
  return values;
}

export function parseCgroupPressure(text = "") {
  const result = {};
  for (const line of String(text).split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (!parts[0]) continue;
    const values = {};
    for (const item of parts.slice(1)) {
      const [key, value] = item.split("=");
      if (key && value !== undefined && Number.isFinite(Number(value))) values[key] = Number(value);
    }
    result[parts[0]] = values;
  }
  return result;
}

function parseCpuQuota(value) {
  const [quota, period] = String(value || "").trim().split(/\s+/);
  if (!quota || quota === "max") return null;
  const q = Number(quota), p = Number(period);
  return Number.isFinite(q) && Number.isFinite(p) && q > 0 && p > 0 ? q / p : null;
}

/** Reads only the current process cgroup v2; returns null on non-v2 hosts. */
export async function readCgroupV2Metrics(options = {}) {
  if ((options.platform || process.platform) !== "linux") return null;
  const procRoot = options.procRoot || "/proc";
  const cgroupRoot = options.cgroupRoot || "/sys/fs/cgroup";
  const membership = await readText(path.join(procRoot, "self/cgroup"));
  const entry = membership.split(/\r?\n/).map(line => line.split(":"))
    .find(parts => parts.length >= 3 && parts[0] === "0" && parts[1] === "");
  if (!entry) return null;
  const relative = (entry.slice(2).join(":") || "/").replace(/^\/+/, "");
  const root = path.resolve(cgroupRoot);
  const cgroup = path.resolve(root, relative);
  if (cgroup !== root && !cgroup.startsWith(root + path.sep)) return null;
  const names = ["memory.current", "memory.max", "cpu.stat", "cpu.max", "pids.current", "pids.max", "memory.events", "cpu.pressure", "memory.pressure"];
  const values = await Promise.all(names.map(name => readText(path.join(cgroup, name))));
  const [memoryCurrent, memoryMax, cpuStat, cpuMax, pidsCurrent, pidsMax, memoryEvents, cpuPressure, memoryPressure] = values;
  return {
    memoryUsedBytes: parseLimit(memoryCurrent),
    memoryLimitBytes: parseLimit(memoryMax),
    cpuUsageUsec: parseCgroupStats(cpuStat).usage_usec ?? null,
    cpuLimitCores: parseCpuQuota(cpuMax),
    processCount: parseLimit(pidsCurrent),
    processLimit: parseLimit(pidsMax),
    memoryEvents: parseCgroupStats(memoryEvents),
    pressure: { cpu: parseCgroupPressure(cpuPressure), memory: parseCgroupPressure(memoryPressure) },
  };
}
