#!/usr/bin/env bash
set -Eeuo pipefail

# Guarded, operator-triggered Lightsail deployment. This script is streamed
# from the reviewed GitHub workflow; it never stores SSH credentials on-host.
DEPLOY_PATH="${1:?usage: deploy-lightsail.sh DEPLOY_PATH API_UNIT EXECUTION_UNIT REPO_AGENT_UNIT API_HEALTH_URL WORKER_HEALTH_URL}"
API_UNIT="${2:?missing API systemd unit}"
EXECUTION_UNIT="${3:?missing execution-worker systemd unit}"
REPO_AGENT_UNIT="${4:?missing repo-agent systemd unit}"
API_HEALTH_URL="${5:?missing API health URL}"
WORKER_HEALTH_URL="${6:?missing worker health URL}"

for unit in "$API_UNIT" "$EXECUTION_UNIT" "$REPO_AGENT_UNIT"; do
  [[ "$unit" =~ ^[A-Za-z0-9_.@:-]+$ ]] || { echo "Invalid systemd unit name." >&2; exit 2; }
done
[[ "$DEPLOY_PATH" = /* && -d "$DEPLOY_PATH/.git" ]] || { echo "DEPLOY_PATH must be an absolute path to the existing Git checkout." >&2; exit 2; }
[[ "$API_HEALTH_URL" = https://* ]] || { echo "API_HEALTH_URL must use HTTPS." >&2; exit 2; }
[[ "$WORKER_HEALTH_URL" =~ ^http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?/healthz$ ]] || {
  echo "WORKER_HEALTH_URL must target the local execution-worker /healthz endpoint." >&2; exit 2;
}

cd "$DEPLOY_PATH"
git rev-parse --is-inside-work-tree >/dev/null
CURRENT_BRANCH="$(git branch --show-current)"
[[ "$CURRENT_BRANCH" = "main" ]] || { echo "Refusing deploy: checkout must be on main (found '$CURRENT_BRANCH')." >&2; exit 2; }
[[ -z "$(git status --porcelain)" ]] || { echo "Refusing deploy: working tree is not clean." >&2; exit 2; }

git fetch --prune origin main
PREVIOUS_SHA="$(git rev-parse HEAD)"
TARGET_SHA="$(git rev-parse origin/main)"
[[ "$PREVIOUS_SHA" != "$TARGET_SHA" ]] || { echo "Already at origin/main ($TARGET_SHA); nothing to deploy."; exit 0; }
git merge-base --is-ancestor "$PREVIOUS_SHA" "$TARGET_SHA" || {
  echo "Refusing non-fast-forward deployment; reconcile the host checkout first." >&2; exit 2;
}

health_check() {
  local api_json worker_json
  api_json="$(curl --fail --silent --show-error --max-time 15 "$API_HEALTH_URL")"
  node -e 'const x=JSON.parse(process.argv[1]); if(x.status!=="ok" || x.database?.connected!==true) process.exit(1)' "$api_json"
  worker_json="$(curl --fail --silent --show-error --max-time 10 "$WORKER_HEALTH_URL")"
  node -e 'const x=JSON.parse(process.argv[1]); if(x.status!=="ok" || x.role!=="execution-worker" || !x.instanceId) process.exit(1)' "$worker_json"
  systemctl is-active --quiet "$API_UNIT"
  systemctl is-active --quiet "$EXECUTION_UNIT"
  systemctl is-active --quiet "$REPO_AGENT_UNIT"
}

rollback() {
  local failure_code=$?
  trap - ERR
  echo "Deployment failed; rolling back to $PREVIOUS_SHA" >&2
  git checkout --detach "$PREVIOUS_SHA" || true
  npm ci --prefix server || true
  npm run build --prefix server || true
  systemctl restart "$API_UNIT" "$EXECUTION_UNIT" "$REPO_AGENT_UNIT" || true
  echo "Rollback attempted. Verify all three units and health endpoints manually." >&2
  exit "$failure_code"
}
trap rollback ERR

git checkout --detach "$TARGET_SHA"
npm ci --prefix server
npm run build --prefix server
systemctl restart "$API_UNIT" "$EXECUTION_UNIT" "$REPO_AGENT_UNIT"

healthy=0
for attempt in $(seq 1 30); do
  if health_check; then healthy=1; break; fi
  sleep 5
done
[[ "$healthy" = "1" ]] || { echo "Post-deploy API/worker health checks did not pass." >&2; false; }

trap - ERR
echo "DEPLOY_SUCCESS previous=$PREVIOUS_SHA deployed=$TARGET_SHA"
echo "API, execution-worker and repo-agent services are active; API DB readiness and execution-worker health passed."
echo "Repo-agent DB identity must still be compared with API identity using db:audit-migration-counts."
