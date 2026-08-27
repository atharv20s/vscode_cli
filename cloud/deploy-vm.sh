#!/usr/bin/env bash
# ==============================================================================
# ATH IDE -- Google Cloud Compute Engine Automated VM Provisioner & Deployer
# ==============================================================================
# Run this script directly inside Google Cloud Shell terminal to:
# 1. Detect your GCP Project
# 2. Enable Compute Engine API
# 3. Create the 24/7 Ubuntu VM
# 4. Open Firewall Port 3001
# 5. Bootstrap ATH IDE with full .env and systemd daemon
# ==============================================================================

set -e

echo "=========================================================================="
echo "[+] ATH IDE -- Automated Google Cloud VM Deployer"
echo "=========================================================================="

# 1. Project Detection
PROJECT_ID=$(gcloud config get-value project 2>/dev/null || true)
if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "(unset)" ]; then
  echo "[!] No default project set. Detecting available projects..."
  PROJECT_ID=$(gcloud projects list --format="value(projectId)" | head -n 1)
  if [ -z "$PROJECT_ID" ]; then
    echo "[-] Error: No Google Cloud projects found. Please create a project first at https://console.cloud.google.com"
    exit 1
  fi
  echo "[+] Setting active project to: ${PROJECT_ID}"
  gcloud config set project "${PROJECT_ID}"
else
  echo "[+] Using active GCP Project: ${PROJECT_ID}"
fi

# 2. Enable Compute Engine API
echo "[+] Enabling Google Cloud Compute Engine API..."
gcloud services enable compute.googleapis.com --project="${PROJECT_ID}"

# 3. VM Parameters
VM_NAME="ath-ide-server"
ZONE="us-central1-a"
MACHINE_TYPE="e2-medium"
DISK_SIZE="30GB"
TAG="ath-ide-port"

# 4. Create Firewall Rule
echo "[+] Configuring Firewall Rule for port 3001..."
if ! gcloud compute firewall-rules describe allow-ath-ide --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud compute firewall-rules create allow-ath-ide \
    --project="${PROJECT_ID}" \
    --allow=tcp:3001 \
    --target-tags="${TAG}" \
    --source-ranges=0.0.0.0/0 \
    --description="Allow inbound traffic for ATH IDE web studio and websocket"
  echo "[+] Firewall rule created."
else
  echo "[+] Firewall rule allow-ath-ide already exists."
fi

# 5. Create or Check Compute Engine VM
echo "[+] Checking VM status for ${VM_NAME} in ${ZONE}..."
if ! gcloud compute instances describe "${VM_NAME}" --zone="${ZONE}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "[+] Provisioning VM: ${VM_NAME} (${MACHINE_TYPE}, ${DISK_SIZE} Ubuntu 24.04 LTS)..."
  gcloud compute instances create "${VM_NAME}" \
    --project="${PROJECT_ID}" \
    --zone="${ZONE}" \
    --machine-type="${MACHINE_TYPE}" \
    --image-family=ubuntu-2404-lts \
    --image-project=ubuntu-os-cloud \
    --boot-disk-size="${DISK_SIZE}" \
    --tags="${TAG}"
  echo "[+] VM created successfully."
else
  echo "[+] VM ${VM_NAME} already exists."
fi

# 6. Fetch External IP Address
echo "[+] Retrieving External IP Address..."
EXTERNAL_IP=$(gcloud compute instances describe "${VM_NAME}" --zone="${ZONE}" --project="${PROJECT_ID}" --format='get(networkInterfaces[0].accessConfigs[0].natIP)')
echo "[+] External IP: ${EXTERNAL_IP}"

# 7. Wait for SSH to become ready
echo "[+] Waiting for SSH daemon on ${VM_NAME}..."
for i in {1..30}; do
  if gcloud compute ssh "${VM_NAME}" --zone="${ZONE}" --project="${PROJECT_ID}" --command="echo ready" >/dev/null 2>&1; then
    echo "[+] SSH is ready!"
    break
  fi
  echo "    Waiting for VM boot (${i}/30)..."
  sleep 5
done

# 8. Bootstrap ATH IDE on the VM
echo "[+] Executing automated provisioning script on VM..."
gcloud compute ssh "${VM_NAME}" --zone="${ZONE}" --project="${PROJECT_ID}" --command="
  curl -fsSL https://raw.githubusercontent.com/atharv20s/vscode_cli/main/cloud/gcp-setup.sh | bash
"

# 9. Sync .env configuration from Cloud Shell onto VM
ENV_SOURCE=""
if [ -f "$HOME/vscode_cli/server/.env" ]; then
  ENV_SOURCE="$HOME/vscode_cli/server/.env"
elif [ -f "$HOME/vscode_cli/.env" ]; then
  ENV_SOURCE="$HOME/vscode_cli/.env"
elif [ -f "./server/.env" ]; then
  ENV_SOURCE="./server/.env"
elif [ -f "./.env" ]; then
  ENV_SOURCE="./.env"
fi

if [ -n "$ENV_SOURCE" ]; then
  echo "[+] Copying ${ENV_SOURCE} to VM..."
  gcloud compute scp "${ENV_SOURCE}" "${VM_NAME}:/tmp/.env" --zone="${ZONE}" --project="${PROJECT_ID}"
  gcloud compute ssh "${VM_NAME}" --zone="${ZONE}" --project="${PROJECT_ID}" --command="
    sudo mv /tmp/.env /opt/ath-ide/server/.env
    sudo systemctl restart ath-ide
  "
  echo "[+] .env successfully synced and service restarted."
else
  echo "[!] Notice: No local .env found to sync. Default template was generated at /opt/ath-ide/server/.env on the VM."
fi

echo ""
echo "=========================================================================="
echo "[+] DEPLOYMENT COMPLETE! ATH IDE IS RUNNING 24/7 ON GOOGLE CLOUD"
echo "=========================================================================="
echo "Access your IDE in any browser at:"
echo "  http://${EXTERNAL_IP}:3001"
echo ""
echo "To SSH into your cloud machine anytime:"
echo "  gcloud compute ssh ${VM_NAME} --zone=${ZONE}"
echo "=========================================================================="
