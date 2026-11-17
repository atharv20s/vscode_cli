# ATH IDE editor roadmap

This document tracks the editor UX and infrastructure implementation sequence.
Pull requests are cumulative and should be reviewed and merged in order.

## Editor UX PRs (#51 – #58)

| PR | Feature | Scope | Status |
|---|---|---|---|
| #51 | Tree-sitter → Monaco Go to Definition and Hover | Workspace-scoped symbol resolution, declaration locations, hover metadata and cached Tree-sitter indexing. | ✅ Merged |
| #52 | Find-in-Files and Git status decorations | Bounded workspace search, changed-file indicators and Monaco changed-line markers. | ✅ Merged |
| #53 | Monaco Git diff viewer | Read-only side-by-side comparison of a workspace file against HEAD. | ✅ Merged |
| #54 | Split editor panes | Independent primary and secondary Monaco editor groups sharing workspace file models. | ✅ Merged |
| #55 | Inline diagnostics and Problems panel | Tree-sitter syntax diagnostics, Monaco markers and navigable Problems list. | ✅ Merged |
| #56 | Breadcrumbs and symbol outline | File-path breadcrumbs, active declaration context and per-file symbol navigation. | ✅ Merged |
| #57 | Multiple terminal sessions | Independent xterm views, PTY session IDs, per-session WebSockets and explicit session close. | ✅ Merged |
| #58 | Editor workflow polish | Diff viewer inline/side-by-side toggle, split editor draggable sash, symbol outline fuzzy search, semantic diagnostics (ESLint/Ruff), and terminal tab rename. | ✅ Merged |

## Agentic Infrastructure PRs (#59 – #64)

| PR | Feature | Scope | Status |
|---|---|---|---|
| #59 | Multi-file Apply & Self-Healing | Version-checked workspace patch apply, per-file conflict detection, retry hints and self-healing diff loop. | ✅ Merged |
| #60 | GitHub Skills Importer & MCP Hardening | Dynamic skill discovery, `npm run skills:import`, MCP stdio isolation, per-server tool allowlists, no-shell subprocess spawning. | ✅ Merged |
| #61 | Inline Monaco Agent Review + TS/Python LSP | View Zone review (Accept/Reject hunk), Ctrl+Y/N shortcuts; TypeScript + Python language-server bridge over `/ws`, Monaco completion/hover/definition providers, 8-process cap. | ✅ Merged |
| #62 | MCP Workspace Isolation | WorkspaceMcpBridge: absolute path rejection, symlink-safe resolution, null-byte blocking, output cap; filesystem MCP server re-enabled with read-only allowlist. | ✅ Merged |
| #63 | Ambient Agentic IDE: Multi-hunk, Inline Edit & Snapshots | Multi-hunk View Zones, Ctrl+K inline edit, ambient context & buffer snapshots, Tab-completion API, agent run snapshots & 1-click rollback, MCP write tool safeguards, curated skills. | ✅ Merged |
| #64 | Secure Execution Sandbox (ATH IDE 2.0) | Kernel namespace unsharing, cgroups v2 resource quotas, network egress lockdown, secret output redaction, and policy engine gate. | ✅ Merged |
| #65 | Worker Provisioning & Lifecycle | Dedicated Linux workers, dynamic capacity scheduling, stale node eviction, and task recovery. | ✅ Merged |
| #66 | Encrypted Distributed Snapshots | AES-256-GCM envelope encryption, 96-bit random IVs, HMAC/auth tag validation, and cross-worker restore. | ✅ Merged |
| #67 | Multi-User Coordination & Locks | Distributed locking with fencing token verification, Redis/in-memory auto-release leases, race prevention. | ✅ Merged |
| #68 | Specialist-Agent Team Orchestrator | Autonomous team pipeline (Planner -> Coder -> Tester -> Security Reviewer), test-driven repair loop. | ✅ Merged |
| #69 | Production Observability & Audit | OpenTelemetry-compatible span tracing, model token cost calculation, and immutable audit logs. | ✅ Merged |

## ATH IDE 2.0 Autonomous Platform Roadmap (#64 – #69)

| Milestone | PR | Focus | Status |
|---|---|---|---|
| Secure Execution Sandbox | #64 | OS-level namespaces, cgroups, egress policy, secret redactor | ✅ Merged |
| Worker Provisioning & Lifecycle | #65 | Dedicated Linux workers, auto-recovery, concurrency | ✅ Merged |
| Encrypted Distributed Snapshots | #66 | S3 snapshot persistence, cross-worker restore | ✅ Merged |
| Multi-User Coordination | #67 | Distributed locking via Redis, multi-tenant workspace isolation | ✅ Merged |
| Specialist-Agent Orchestration | #68 | Planner, coder, reviewer, and tester teams with context graph | ✅ Merged |
| Production Observability | #69 | OpenTelemetry tracing, token cost metering, execution audits | ✅ Merged |

## Merge order

Merge in ascending PR number order.  Each PR builds on its predecessor and targets `main`.

## Remaining phases

| Phase | Description | Prerequisite |
|---|---|---|
| Distributed LSP pool | Replace per-instance 8-process limit with a shared LSP daemon registry backed by Redis or a sidecar for multi-node deployments. | PR #61 merged |
| OS-level sandbox | Wrap MCP and LSP child processes in Docker or seccomp/namespace isolation for production multi-tenant safety. | PR #62 merged |
| Production acceptance | Live runtime checks: DATABASE_URL, Redis, multi-user workspace isolation, browser acceptance suite. | All above |

## Acceptance boundary

A code change or passing CI job is **not** production acceptance.  Browser
checks, workspace-isolation checks and live runtime checks must be completed
separately before declaring any feature production-ready.  No deployment is
performed by these PRs.
