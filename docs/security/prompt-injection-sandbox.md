# Prompt-injection and workspace sandbox controls

## Security boundary

Prompt injection is not reliably solved by a system prompt. Repository files, webpages,
terminal output, issue text, dependency messages and tool results are untrusted data.
The model must not treat those sources as authority to change policy or disclose secrets.
The runtime must independently constrain what the model can execute.

## Controls implemented

- The command permission engine auto-allows only a small read-only inspection allowlist.
- Unknown commands, shell composition, redirects, substitutions, installs, tests, network
  clients and other commands require a platform permission approval. Approval timeout fails closed.
- A small set of destructive/high-impact command patterns is denied.
- Agent instructions explicitly classify repository and external content as untrusted data,
  prohibit secret disclosure and prohibit using shell to bypass tool permissions.
- Each workspace container receives its own Docker internal network by default. Containers
  are not placed together on a shared user network and do not receive general internet egress.
- Containers retain resource limits, dropped Linux capabilities, no-new-privileges,
  read-only container root, non-root UID/GID and a single writable workspace mount.

## Operational notes

- DOCKER_WORKSPACE_NETWORK=none disables workspace networking completely. Preview routing
  will not work in this mode.
- With a named DOCKER_WORKSPACE_NETWORK (the default), the value acts as an enablement/config
  setting; actual workspace networks are generated per workspace as athide-net-<digest>.
- Existing containers on the former shared network are replaced when the worker provisions
  them after this version is deployed. Plan for active terminals/previews to restart on rollout.
- The host-side preview proxy still needs to reach the container's internal IP. Keep the worker
  host and Docker daemon private; do not expose Docker's API socket or TCP endpoint.

## What this does not guarantee

- No prompt-injection defense can guarantee that the model will never be manipulated.
- A user-approved command can still do harmful things inside that user's workspace.
- Docker isolation is not a substitute for a dedicated VM/microVM boundary against a hostile
  kernel/container escape. Keep Docker and the host OS patched and run the worker on a
  dedicated, least-privilege host.
- The permission engine protects agent run_command calls. The interactive PTY is a direct
  user terminal and must remain separately protected by authenticated session ownership.
- Tool/file permissions and approval UI must be tested end-to-end in the deployed environment.
- Network isolation does not prevent all covert channels through explicitly exposed preview
  endpoints or other host services; do not put credentials in the workspace.

## Required release verification

1. Run node --test src/services/permissionEngine.test.js from server/.
2. Run the full server test suite and build.
3. Verify two workspace IDs produce different Docker network names and that the networks
   are internal; inspect actual container mounts/capabilities/network settings on the worker.
4. Verify a normal command causes an approval event, approval timeout denies execution, and
   explicit approval is scoped to the requesting workspace.
5. Run adversarial tests with malicious README/AGENTS.md/webpage content requesting secret
   disclosure, curl exfiltration, destructive commands and container escape.
6. Confirm authenticated terminal routes enforce user/workspace ownership before production.
