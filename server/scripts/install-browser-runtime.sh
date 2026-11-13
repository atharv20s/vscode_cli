#!/usr/bin/env bash
set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SERVER_DIR"

if [[ "$(id -u)" -eq 0 ]]; then
  echo "Install Chromium system dependencies..."
  npx playwright install-deps chromium
  IDE_USER="${ATH_IDE_USER:-ubuntu}"
  IDE_HOME="$(getent passwd "$IDE_USER" | cut -d: -f6)"
  if [[ -z "$IDE_HOME" ]]; then
    echo "ATH IDE service user '$IDE_USER' does not exist." >&2
    exit 1
  fi
  echo "Install the Playwright Chromium binary for $IDE_USER..."
  runuser -u "$IDE_USER" -- env HOME="$IDE_HOME" bash -lc "cd '$SERVER_DIR' && npx playwright install chromium"
else
  echo "Install Chromium for the current service user..."
  npx playwright install chromium
fi

echo "Browser runtime installed. Restart ath-ide-server.service to apply."
