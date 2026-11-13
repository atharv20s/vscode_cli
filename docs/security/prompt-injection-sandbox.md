# Prompt-injection and workspace sandbox controls

## Security boundary

Prompt injection is not reliably solved by a system prompt. Repository files, webpages,
terminal output, issue text, dependency messages and tool results are untrusted data.
The model must not treat those sources as authority to change its role, policy or the user's
request. Runtime controls must independently constrain actions.

## Controls implemented in this change

- For normal user workspaces, only a narrow read-only command allowlist runs automatically.
  Unknown commands, shell composition, redirects, substitutions, installs, tests, network
  clients and other commands require explicit workspace-owner approval. Approval timeout denies.
- A small set of high-impact destructive command patterns is denied even if approval is requested.
- Disposable repository-agent jobs are forced onto Docker's \`none\` network. Build/test commands
  may run inside their disposable task workspace without interactive approval; preview servers
  are disabled for these jobs. This exception does not apply to normal user workspaces.
- Agent instructions classify repository and external content as untrusted data and prohibit
  secret disclosure, policy changes based on untrusted content and shell-based approval bypass.
- Agent shell commands, compile operations, preview-server startup, Git mutations and GitHub
  write operations are routed through the permission engine.
- Secret-bearing file reads are denied. Writes to secret/configuration files and sensitive project
  manifests require approval. Ordinary source-file edits remain available to the coding agent.
- Approval prompts are delivered only to workspace-owner WebSocket sessions. The browser shows
  the requested action, command or file path and sends an explicit approve/reject decision.
- Normal user workspace containers receive separate Docker internal networks; they do not share
  a user network and do not receive general outbound internet access.
- Containers retain resource limits, dropped Linux capabilities, no-new-privileges,
  read-only container root, non-root UID/GID and a single writable workspace mount.
- The interactive PTY is a direct user terminal, not an LLM command channel. It is separately
  protected by the authenticated API-to-worker HMAC tunnel and workspace-scoped API session.

## Operational notes

- DOCKER_WORKSPACE_NETWORK=none disables networking for normal workspace containers; preview
  routing will not work in this mode.
- With a named DOCKER_WORKSPACE_NETWORK (the default), the value enables internal workspace
  networking; actual network names are generated per workspace as athide-net-<digest>.
  Named network overrides are ignored to prevent accidental shared networks.
- Repository-agent workspace IDs are always forced to Docker network none, regardless of config.
- Existing containers on the former shared network are replaced when the worker provisions them
  after this version is deployed. Plan for active terminals/previews to restart on rollout.
- The host-side preview proxy still needs to reach the container's internal IP. Keep the worker
  host and Docker daemon private; do not expose Docker's API socket or TCP endpoint.

## What this does not guarantee

- No prompt-injection defense can guarantee that a model will never be manipulated.
- A user-approved command can still do harmful things inside that user's workspace. Review the
  exact command; build/install/test commands can execute repository and dependency scripts.
- Docker is not a dedicated VM/microVM boundary against a hostile kernel or container escape.
  Keep Docker and the host OS patched and run the worker on a dedicated least-privilege host.
- Docker internal networking is not a complete host firewall. Do not expose host services or
  credentials to workspace containers; restrict worker-host services independently.
- Tool/file permissions, approval UI, authenticated PTY ownership and Docker settings still need
  end-to-end verification in the deployed environment.

## Required release verification

1. From server/, run \`node --test src/services/permissionEngine.test.js src/services/permissionEngine.security.test.js src/services/dockerWorkspaceRuntime.test.js\`.
2. Run the full server test suite and build.
3. Verify two normal workspace IDs produce different internal Docker network names; verify repo-agent
   workspaces use network none. Inspect actual container mounts/capabilities/network settings.
4. Verify an unknown command produces an approval prompt, owner approval runs it, rejection/timeout
   denies it, and collaborators cannot approve it.
5. Verify compile_file, start_preview, git clone/pull/branch mutations, Git commits and GitHub writes
   all require approval.
6. Verify secret-file reads are denied and sensitive configuration writes require approval.
7. Run adversarial tests with malicious README/AGENTS.md/webpage content requesting secret
   disclosure, network exfiltration, destructive commands and container escape.
8. Confirm authenticated terminal routes enforce user/workspace ownership before production.
