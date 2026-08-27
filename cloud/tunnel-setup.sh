#!/usr/bin/env bash
# ==============================================================================
# ATH IDE -- Zero-Config Secure Cloudflare Tunnel Setup
# ==============================================================================
# Exposes ATH IDE running on port 3001 over free, encrypted HTTPS/WSS
# Accessible from any browser/device without opening firewall ports.
# ==============================================================================

set -e

echo "[+] Setting up Cloudflare Tunnel for ATH IDE..."

# 1. Check/Install cloudflared
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "[+] Downloading cloudflared binary..."
  ARCH=$(uname -m)
  if [ "$ARCH" = "x86_64" ]; then
    wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
    sudo dpkg -i cloudflared-linux-amd64.deb
    rm cloudflared-linux-amd64.deb
  elif [ "$ARCH" = "aarch64" ]; then
    wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
    sudo dpkg -i cloudflared-linux-arm64.deb
    rm cloudflared-linux-arm64.deb
  else
    echo "[-] Unsupported architecture: $ARCH"
    exit 1
  fi
fi

echo "[+] cloudflared version: $(cloudflared --version)"

# 2. Start quick tunnel pointing to port 3001
echo "[+] Starting tunnel proxy to http://localhost:3001..."
echo "[!] Copy the https://*.trycloudflare.com URL displayed below to access your IDE anywhere:"
echo ""

cloudflared tunnel --url http://localhost:3001
