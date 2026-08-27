# Google Cloud Platform & Permanent Remote VM Deployment Guide

Comprehensive instructions for deploying ATH IDE on a Google Cloud Platform (GCP) Compute Engine virtual machine or any permanent Linux host to run 24/7 with persistent storage, full root interactive terminal, and secure HTTPS access.

---

## 1. Create a Google Cloud Compute Engine VM

1. Open the [Google Cloud Console](https://console.cloud.google.com/compute/instances).
2. Click **Create Instance**.
3. Configure the VM specifications:
   - **Name**: `ath-ide-server`
   - **Region**: Select your closest region (e.g., `us-central1`, `asia-south1`, `europe-west1`).
   - **Machine Type**: `e2-medium` (2 vCPU, 4 GB memory) or `e2-standard-2`. Free tier users can use `e2-micro`.
   - **Boot Disk**: `Ubuntu 24.04 LTS` or `Ubuntu 22.04 LTS`, size: `30 GB` or more (Standard Persistent Disk).
   - **Firewall**: Check **Allow HTTP traffic** and **Allow HTTPS traffic**.
4. Click **Create**.

---

## 2. One-Command Automated Setup

Connect to your VM via SSH in the GCP Console or from your local terminal:

```bash
gcloud compute ssh ath-ide-server --zone=<your-zone>
```

Once connected to the VM, run the automated 1-click provisioning script:

```bash
curl -fsSL https://raw.githubusercontent.com/atharv20s/vscode_cli/main/cloud/gcp-setup.sh | bash
```

Alternatively, if you already cloned the repository:

```bash
git clone https://github.com/atharv20s/vscode_cli.git /opt/ath-ide
cd /opt/ath-ide
bash cloud/gcp-setup.sh
```

---

## 3. Configuration & API Keys

The installer creates a `.env` file at `/opt/ath-ide/server/.env`.
Edit the file to add your API keys:

```bash
nano /opt/ath-ide/server/.env
```

Ensure the following variables are set:

```env
OPENROUTER_API_KEY=your_openrouter_api_key
TAVILY_API_KEY=your_tavily_api_key
REDIS_URL=redis://default:password@host:port
NODE_ENV=production
PORT=3001
WORKSPACE_ROOT=/workspace
```

After updating `.env`, restart the systemd service:

```bash
sudo systemctl restart ath-ide
```

---

## 4. Managing the 24/7 Systemd Service

ATH IDE runs as a background daemon managed by systemd:

- **Check Service Status**:
  ```bash
  sudo systemctl status ath-ide
  ```
- **View Live Logs**:
  ```bash
  sudo journalctl -u ath-ide -f
  ```
- **Restart Service**:
  ```bash
  sudo systemctl restart ath-ide
  ```
- **Stop Service**:
  ```bash
  sudo systemctl stop ath-ide
  ```

---

## 5. Connecting from Your Browser

### Option A: Direct IP Connection (Firewall Rule)

1. In GCP Console, go to **VPC Network** > **Firewall**.
2. Click **Create Firewall Rule**:
   - **Name**: `allow-ath-ide-3001`
   - **Targets**: `All instances in the network`
   - **Source IPv4 ranges**: `0.0.0.0/0` (or your personal IP)
   - **Protocols and ports**: Specified protocols and ports > `tcp: 3001`
3. Access in browser: `http://<YOUR_VM_EXTERNAL_IP>:3001`

### Option B: Free Encrypted Cloudflare Tunnel (Zero Open Ports)

Run the tunnel setup script on the VM:

```bash
bash /opt/ath-ide/cloud/tunnel-setup.sh
```

This generates a free, encrypted HTTPS/WSS URL (e.g., `https://random-words.trycloudflare.com`) allowing you to access the IDE from any browser or phone without opening firewall ports.

---

## 6. Updating Code on the Cloud VM

To pull the latest updates from GitHub onto your running cloud instance:

```bash
cd /opt/ath-ide
git pull origin main
cd server && npm install --production
sudo systemctl restart ath-ide
```
