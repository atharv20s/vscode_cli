#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo bash scripts/install-worker-security.sh" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_SOURCE="$REPO_ROOT/server/security/seccomp-workspace.json"
UNIT_SOURCE="$REPO_ROOT/scripts/ath-ide-worker.service"
PROFILE_TARGET="/etc/ath-ide/seccomp-workspace.json"
UNIT_TARGET="/etc/systemd/system/ath-ide-worker.service"

[[ -s "$PROFILE_SOURCE" ]] || { echo "Missing seccomp profile: $PROFILE_SOURCE" >&2; exit 1; }
[[ -s "$UNIT_SOURCE" ]] || { echo "Missing worker unit: $UNIT_SOURCE" >&2; exit 1; }
command -v docker >/dev/null || { echo "Docker CLI is required on this worker host." >&2; exit 1; }
[[ -S /var/run/docker.sock ]] || { echo "Docker socket is unavailable; refusing to configure a non-worker host." >&2; exit 1; }
docker info >/dev/null

install -d -o root -g root -m 0755 /etc/ath-ide
install -o root -g root -m 0644 "$PROFILE_SOURCE" "$PROFILE_TARGET"
install -o root -g root -m 0644 "$UNIT_SOURCE" "$UNIT_TARGET"
systemctl daemon-reload

echo "Installed explicit workspace seccomp profile and hardened ath-ide-worker.service."
echo "No service was restarted. Review the unit and profile, then restart the worker in a maintenance window."
echo "Verify new containers with docker inspect; existing containers are replaced when next provisioned if they fail the security baseline."
