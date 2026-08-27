#!/usr/bin/env bash
# ==============================================================================
# ATH IDE -- Google Cloud & Linux Compute Engine 1-Click Automated Setup
# ==============================================================================
# This script provisions an Ubuntu/Debian Google Cloud VM or any Linux host:
# 1. Installs Node.js 22 LTS, Git, Python 3, Build Tools, and Docker
# 2. Configures a persistent workspace at /workspace
# 3. Clones/pulls the repository and installs production dependencies
# 4. Sets up a systemd daemon (ath-ide.service) so it runs 24/7
# 5. Configures automatic restart on crash or VM reboot
# ==============================================================================

set -e

echo "[+] Starting ATH IDE automated provisioning for Google Cloud..."

# 1. Update system packages
echo "[+] Updating apt repositories..."
sudo apt-get update -y
sudo apt-get install -y curl wget git build-essential python3 python3-pip ufw

# 2. Install Node.js 22.x LTS
if ! command -v node >/dev/null 2>&1; then
  echo "[+] Installing Node.js 22.x LTS..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "[+] Node version: $(node -v)"
echo "[+] NPM version: $(npm -v)"

# 3. Create persistent workspace storage directory
WORKSPACE_DIR="/workspace"
echo "[+] Ensuring persistent workspace directory at ${WORKSPACE_DIR}..."
sudo mkdir -p "${WORKSPACE_DIR}"
sudo chown -R $USER:$USER "${WORKSPACE_DIR}"
sudo chmod -R 755 "${WORKSPACE_DIR}"

# 4. Set up App Directory
APP_DIR="/opt/ath-ide"
echo "[+] Setting up application directory at ${APP_DIR}..."
if [ -d "${APP_DIR}/.git" ]; then
  echo "[+] Existing installation found. Pulling latest code..."
  cd "${APP_DIR}"
  git pull origin main
else
  echo "[+] Cloning repository to ${APP_DIR}..."
  sudo mkdir -p "${APP_DIR}"
  sudo chown -R $USER:$USER "${APP_DIR}"
  git clone https://github.com/atharv20s/vscode_cli.git "${APP_DIR}"
  cd "${APP_DIR}"
fi

# 5. Install Node dependencies
echo "[+] Installing server dependencies..."
cd "${APP_DIR}/server"
npm install --production

# 6. Configure .env file
if [ ! -f "${APP_DIR}/server/.env" ]; then
  echo "[+] Generating .env configuration..."
  cp "${APP_DIR}/.env.example" "${APP_DIR}/server/.env"
  # Generate cryptographically secure JWT and session secrets
  JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  sed -i "s/JWT_SECRET=.*/JWT_SECRET=${JWT_SECRET}/" "${APP_DIR}/server/.env"
  sed -i "s/SESSION_SECRET=.*/SESSION_SECRET=${SESSION_SECRET}/" "${APP_DIR}/server/.env"
  sed -i "s/PORT=.*/PORT=3001/" "${APP_DIR}/server/.env"
  sed -i "s/NODE_ENV=.*/NODE_ENV=production/" "${APP_DIR}/server/.env"
fi

# 7. Configure systemd Service for 24/7 execution
echo "[+] Installing systemd service (ath-ide.service)..."
cat <<EOF | sudo tee /etc/systemd/system/ath-ide.service
[Unit]
Description=ATH IDE - Autonomous AI Development Studio
After=network.target

[Service]
Type=simple
User=${USER}
WorkingDirectory=${APP_DIR}/server
ExecStart=$(which node) src/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=3001
Environment=WORKSPACE_ROOT=${WORKSPACE_DIR}

# Resource limits
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

# 8. Reload systemd, enable, and start service
echo "[+] Reloading systemd daemon and starting ath-ide..."
sudo systemctl daemon-reload
sudo systemctl enable ath-ide
sudo systemctl restart ath-ide

# 9. Configure Firewall (allow port 3001)
echo "[+] Configuring firewall for port 3001..."
sudo ufw allow 3001/tcp comment 'ATH IDE HTTP and WebSocket' || true

# 10. Status Check
sleep 2
if sudo systemctl is-active --quiet ath-ide; then
  PUBLIC_IP=$(curl -s ifconfig.me || hostname -I | awk '{print $1}')
  echo ""
  echo "=========================================================================="
  echo "[+] ATH IDE is successfully installed and RUNNING 24/7!"
  echo "=========================================================================="
  echo "Access the IDE in your browser at:"
  echo "  http://${PUBLIC_IP}:3001"
  echo ""
  echo "To view live logs: sudo journalctl -u ath-ide -f"
  echo "To restart:       sudo systemctl restart ath-ide"
  echo "To stop:          sudo systemctl stop ath-ide"
  echo "=========================================================================="
else
  echo "[-] Warning: Service failed to start. Check logs with: sudo journalctl -u ath-ide -n 50"
  exit 1
fi
