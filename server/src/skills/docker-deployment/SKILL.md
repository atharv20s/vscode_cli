# Docker, cloud runtime and deployment

Inspect the existing Dockerfiles, compose files, runtime configuration and deployment target before changing infrastructure.

- Run each user workspace with explicit CPU, memory, process and disk limits.
- Use non-root identities where possible and keep host paths outside the workspace inaccessible.
- Do not mount the Docker socket inside untrusted workspace containers.
- Keep internal databases, Redis and worker control ports private.
- Persist workspace data independently from ephemeral containers.
- Route previews through an authenticated gateway; validate workspace ownership and allowed ports.
- Forward WebSocket upgrades and preserve required headers for HMR.
- Use health checks, graceful shutdown, bounded logs and restart policies.
- Never claim a cloud deployment succeeded without checking service health and an end-to-end request.
