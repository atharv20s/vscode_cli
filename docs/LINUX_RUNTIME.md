# Linux worker runtime contract

ATH IDE's Linux worker is the execution boundary for untrusted project code. The
API process must treat worker diagnostics as observations, never as proof that
a workload is safely isolated.

## Process-scoped diagnostics

Authenticated `GET /api/runtime/linux` reports the worker kernel release,
architecture, Node runtime, cgroup version, process namespace availability,
seccomp mode, no-new-privileges state, and cgroup v2 memory/CPU/PID limits.
It reads procfs and cgroupfs only. It does not execute shell commands, return
hostnames, expose namespace inode identifiers, or inspect environment files.

On non-Linux hosts the endpoint returns HTTP 501 with `supported: false`.
Unavailable cgroup files are represented as unknown/null rather than guessed.

## Isolation requirements for execution workers

- Run each user workspace under a distinct unprivileged UID or user namespace.
- Apply cgroup v2 CPU, memory and pids limits per workspace.
- Use private mount, PID, IPC and network namespaces; do not share the host
  network namespace with untrusted jobs.
- Enable seccomp and `no_new_privs`; drop all Linux capabilities.
- Keep the Docker/container runtime socket outside every workspace.
- Mount workspace data only into its owning worker and use read-only system
  mounts. Do not mount host credentials or cloud metadata endpoints.
- Treat this diagnostics endpoint as telemetry, not an enforcement mechanism.
  Enforcement must occur in the worker/container configuration and be tested
  with adversarial workloads.

## Rollout

Deploy this code to Linux workers and verify the returned process-scoped limits
against the worker's actual cgroup configuration. A Windows development host
will correctly report that Linux diagnostics are unsupported.
