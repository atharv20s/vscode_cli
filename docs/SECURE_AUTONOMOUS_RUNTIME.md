# ATH IDE 2.0 — Secure Autonomous Runtime

## Executive Overview

ATH IDE 2.0 transitions the platform from a feature-complete agentic editor to a production-grade autonomous software engineering platform. At the core of this milestone is **OS-level isolation, defense-in-depth sandboxing, and adversarial security**.

Application-level path checks are not a substitute for kernel-level boundaries. In ATH IDE 2.0, all agent operations execute inside kernel-enforced sandboxes with strict resource limits and real-time credential redaction.

---

## 1. Five Pillars of the Sandbox (PR #64)

```
+-----------------------------------------------------------------------------------+
|                            ATH IDE 2.0 EXECUTION ENGINE                           |
+-----------------------------------------------------------------------------------+
                                          |
    +-----------------+-------------------+------------------+-----------------+
    |                 |                   |                  |                 |
    v                 v                   v                  v                 v
[ Process & PID ]  [ Filesystem ]      [ Network Egress ] [ Resource Limits ] [ Secret Vault ]
* Bubblewrap       * Dedicated bind-   * Default: NONE    * cgroups v2        * Real-time stream
  namespaces         mount /workspace  * Internal bridge    MemoryMax (1GB)     redactor
* Unshare: user,   * Symlink escape      for preview proxy  CPUQuota (100%)   * Strips ghp_, sk-,
  pid, net, ipc      prevention        * Block internet     TasksMax (256)      AKIA, passwords
* seccomp filter   * Immutable host      outbound access  * 45s hard timeout  * Zero credentials
* no-new-privs       system binds                                               in context
```

### Pillar 1: Kernel Process & Namespace Isolation
* **Linux Bubblewrap (`bwrap`)**: Every command runs inside a fresh, transient namespace unsharing `CLONE_NEWUSER`, `CLONE_NEWPID`, `CLONE_NEWNET`, `CLONE_NEWIPC`, and `CLONE_NEWUTS`.
* **Privilege Drop**: Host `ALL` capabilities dropped (`--cap-drop ALL`), `no-new-privileges` enforced, suid/sgid disabled.
* **Seccomp Filters**: System calls gated by Docker/host seccomp security profile; dangerous syscalls (`ptrace`, `kexec`, `reboot`, `sys_chroot`) blocked at the kernel boundary.

### Pillar 2: Per-Workspace Filesystem Isolation
* **Workspace Containment**: Only the tenant's canonical workspace directory is mounted at `/workspace:rw`.
* **Symlink Traversal Prevention**: `resolveWorkspacePaths` and `resolveSafeWorkspacePath` canonicalize paths segment-by-segment and throw if any intermediate segment resolves to a symlink pointing outside the workspace.
* **Read-Only Host Root**: `/usr`, `/bin`, `/lib`, and system utilities are mounted read-only (`--ro-bind`). Host sensitive paths (`/etc/shadow`, `/root`, `/proc/kcore`, Docker socket) are strictly inaccessible.
* **Private Scratchpad**: `/tmp` is mounted on an isolated `tmpfs` (256MB, `noexec`, `nosuid`).

### Pillar 3: Network Egress Lockdown
* **Default Lockdown (`none`)**: Disposable repo agents and autonomous tasks have network egress set to `none` (`--unshare-net`).
* **Preview Bridge**: When a web preview is active, containers connect exclusively to an internal Docker bridge reachable only by the local reverse-proxy, preventing general outbound internet scanning or data exfiltration.

### Pillar 4: cgroups v2 Resource Limits
* **Memory**: `MemoryMax=1G`, `memory-swap=1G`. OOM-killer terminates processes exceeding budget without affecting neighbor workspaces.
* **CPU**: `CPUQuota=100%` (1 core allocation).
* **Tasks/PIDs**: `TasksMax=256` / `--pids-limit 256` prevents forkbomb attacks.
* **Execution Timeouts**: Default 45s bounded timeout with automated SIGTERM / SIGKILL escalation.

### Pillar 5: Real-Time Secret Redaction
* **Environment Scrubbing**: Subprocesses inherit an empty environment (`--clearenv`) with only whitelisted variables (`PATH`, `LANG`, `TERM`, `HOME=/tmp`).
* **Output Sanitizer (`secretSanitizer.js`)**: All stdout, stderr, and tool outputs are scanned in real-time. GitHub tokens, OpenAI/Anthropic keys, AWS credentials, database passwords, and private keys are replaced with `[REDACTED_SECRET]` before reaching the LLM context or WebSocket subscribers.

---

## 2. Policy Engine (Permission Gates)

The Universal Policy Engine classifies all commands and file operations into three tiers:

| Tier | Behavior | Trigger Conditions |
|---|---|---|
| **`DENY`** | Instantly blocked with security audit event | Destructive commands (`rm -rf`, `mkfs`, `dd`, forkbombs, force pushes), access to secret files (`.env*`, `id_rsa`, `.aws/credentials`, `terraform.tfstate`, `/etc/shadow`), Docker socket access |
| **`ASK`** | Pauses agent turn and requests user confirmation | Commands with shell operators (`;&|<>`), package installs, sensitive configuration edits (`package.json`, `Dockerfile`, workflows) |
| **`ALLOW`** | Automatically executed in sandbox | Safe read-only inspection (`git status`, `git diff`, `pwd`, version checks, non-sensitive file reads) |

---

## 3. Autonomous Platform Roadmap (Milestones 2.0 – 2.5)

| PR | Milestone | Description | Status |
|---|---|---|---|
| **#64** | **Secure Execution Sandbox** | OS-level namespaces, cgroups v2, network egress lockdown, secret sanitizer, policy engine gate | **Implemented** |
| **#65** | **Worker Provisioning & Lifecycle** | Dedicated Linux workers, execution worker daemon, health checks, automatic recovery | Planned |
| **#66** | **Encrypted Distributed Snapshots** | S3 snapshot persistence, client-side encryption, cross-worker workspace restore | Planned |
| **#67** | **Multi-User Coordination** | Distributed locking via Redis, multi-tenant workspace isolation drills | Planned |
| **#68** | **Specialist-Agent Orchestration** | Planner, coder, reviewer, and tester agent teams with shared context graph | Planned |
| **#69** | **Production Observability** | OpenTelemetry spans, token-cost metering, audit log exporter | Planned |
