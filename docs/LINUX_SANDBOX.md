# Linux-native sandbox execution

Set `EXECUTION_RUNTIME=linux` on a Linux worker to use the Linux sandbox
backend for agent background commands. The backend combines:

- **systemd user scopes** for per-task cgroup v2 CPU, memory and process limits.
- **bubblewrap** for a new user, PID, IPC and UTS namespace, a private /proc and
  /dev, read-only system mounts, an ephemeral /tmp, and a workspace-only
  writable mount.
- **A clean environment**: host environment variables, cloud credentials,
  tokens and host HOME are not inherited.
- **Network isolation by default**: `LINUX_SANDBOX_NETWORK=none` creates a
  private network namespace. `host` networking is an explicit administrator
  opt-in and must still be governed by the permission engine.

Required worker packages: `systemd` with a functioning per-user manager and
`bubblewrap` (`bwrap`). The worker must support unprivileged user
namespaces. If any primitive is missing or workspace path validation fails,
execution fails closed; there is no fallback to host shell execution.

Suggested worker settings:

```env
EXECUTION_RUNTIME=linux
LINUX_SANDBOX_MEMORY_MAX=2G
LINUX_SANDBOX_CPU_QUOTA=200%
LINUX_SANDBOX_TASKS_MAX=256
LINUX_SANDBOX_NETWORK=none
LINUX_SANDBOX_MAX_OUTPUT_BYTES=1048576
```

The backend also provides interactive PTYs through the same systemd user
scope and bubblewrap workspace boundary. The terminal session manager selects
this provider when `EXECUTION_RUNTIME=linux`; it never falls back to the host
shell. Validate user-manager
availability, cgroup v2 limits, user namespaces and bubblewrap mounts on a
staging Linux host before production rollout. No host-level privileged daemon
or cloud resource is provisioned by this code change.
