# Isolated Linux Workspace Runtime

The API now supports one resource-limited Docker container per authenticated workspace. Each container receives only its owner workspace mounted at `/workspace`.

## Build the workspace image

Run this on the Docker-capable worker host:

```bash
docker build -f server/Dockerfile.workspace -t ath-ide-workspace:local .
```

## Configure the API worker

```env
EXECUTION_RUNTIME=docker
DOCKER_WORKSPACE_IMAGE=ath-ide-workspace:local
DOCKER_WORKSPACE_UID=1000
DOCKER_WORKSPACE_GID=1000
DOCKER_WORKSPACE_NETWORK=none
```

The API process must run on the same host as Docker Engine, and `WORKSPACE_ROOT` must be a path visible to that Docker daemon. The runtime applies memory, CPU, PID, capability, read-only-root-filesystem, and no-new-privileges limits. The user workspace is the only writable bind mount.

## Network access

Container networking defaults to `none`. This prevents untrusted workspace code from reaching the internet or other host/network services. If package downloads are required, `DOCKER_WORKSPACE_NETWORK=bridge` can be enabled only after the worker host has appropriate egress/firewall restrictions. Bridge networking is not an egress security boundary by itself.

## Deployment limitation

The current production backend deploys to Google Cloud Run. Cloud Run does not expose a local Docker Engine or support mounting a Cloud Run filesystem into sibling Docker containers. Therefore this runtime must not be enabled on the existing Cloud Run service. A separate Docker-capable worker with shared/persisted workspace storage and an authenticated execution-worker interface is still required for that deployment model.

Static file previews are authenticated with short-lived, workspace-scoped preview tokens. Live development-server preview proxying from isolated containers is not implemented yet and remains disabled in production.