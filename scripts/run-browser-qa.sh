#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

python3 -m http.server 4173 --directory benchmarks/fixtures/browser-acceptance >/tmp/ath-browser-fixture.log 2>&1 &
SERVER_PID=$!
trap "kill $SERVER_PID 2>/dev/null || true" EXIT

for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4173/ >/dev/null 2>&1; then break; fi
  sleep 0.5
done

cd "$ROOT_DIR/server"
export APP_URL=http://127.0.0.1:4173
export VISUAL_BASELINE_DIR=/tmp/ath-visual-baselines

echo "--- Run 1: Capturing Visual Baseline ---"
UPDATE_VISUAL_BASELINES=1 npm run bench:browser

echo "--- Run 2: Comparing against Visual Baseline ---"
npm run bench:browser

echo "Browser acceptance and visual regression tests PASSED!"

