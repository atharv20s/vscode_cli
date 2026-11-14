# Cgroup-aware worker health metrics

On Linux with cgroup v2, the system health monitor now prefers the current
process cgroup's CPU usage, memory.current/memory.max and pids.current/pids.max
over host-wide totals. It also reports cgroup memory event counters and CPU /
memory PSI pressure averages. Existing `cpuPercent`, `memoryUsedMB` and
`memoryTotalMB` fields become worker-scope values when cgroup telemetry is
available; `hostCpuPercent` remains available for host context.

If cgroup v2 is unavailable or unreadable, the monitor falls back to host OS
metrics and reports `cgroup: null`. No host process command execution or
privileged access is required.
