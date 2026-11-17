#!/usr/bin/env bash
# =============================================================================
# ATH IDE 2.0 — Production Cloud Deployment & Verification Script
# =============================================================================
set -euo pipefail

echo "========================================================"
echo "   🚀 Deploying ATH IDE 2.0 Autonomous Cloud Platform   "
echo "========================================================"

# 1. Environment Verification
if [[ ! -f .env ]]; then
  echo "⚠️  No .env file found. Creating from template..."
  cat << 'EOF' > .env
NODE_ENV=production
POSTGRES_USER=ath
POSTGRES_PASSWORD=$(openssl rand -hex 16)
POSTGRES_DB=ath_ide
WORKER_SHARED_SECRET=$(openssl rand -hex 32)
DOMAIN=localhost
DEFAULT_LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=
EXECUTION_RUNTIME=docker
EOF
  echo "✅ Created .env with generated secrets. Configure your LLM API keys before production traffic."
fi

# 2. Build and Boot Services
echo "📦 Building and starting Docker Compose stack..."
docker compose -f docker-compose.production.yml pull --quiet || true
docker compose -f docker-compose.production.yml up -d --build

# 3. Wait for Healthchecks
echo "⏳ Waiting for services to become healthy..."
sleep 5
docker compose -f docker-compose.production.yml ps

# 4. Run Live Production Acceptance Checks
echo "🧪 Running Production Acceptance Drills inside container..."
docker compose -f docker-compose.production.yml exec -T ath-ide-api node -e "
import('./src/services/productionAcceptanceRunner.js').then(async m => {
  const report = await m.runProductionAcceptanceChecks();
  console.log(JSON.stringify(report, null, 2));
  if (report.overall !== 'PASSED') process.exit(1);
});
"

echo "========================================================"
echo "   ✅ ATH IDE 2.0 Cloud Platform Deployed & Verified    "
echo "========================================================"
