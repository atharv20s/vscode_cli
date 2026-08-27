# 🚀 Oracle Cloud Always Free Deployment Guide for ATH IDE

This guide walks you through setting up your **100% Free 24/7 Cloud IDE** on an **Oracle Cloud Ampere A1 instance (4 ARM vCPUs, 24 GB RAM, 200 GB SSD)** with Kubernetes (K3s).

---

## 1. Create Your Free 24 GB RAM Instance on Oracle Cloud

1. Log into your **[Oracle Cloud Console](https://cloud.oracle.com)**.
2. In the top search bar, type **Instances** and click **Compute ➔ Instances**.
3. Click **Create Instance**:
   - **Name**: `ath-ide-production`
   - **Image**: Click *Edit* ➔ Select **Canonical Ubuntu 24.04 LTS (aarch64 / ARM)**.
   - **Shape**: Click *Change Shape* ➔ Select **Ampere (ARM)**:
     - **OCPUs**: `4`
     - **Memory**: `24 GB` (Marked *Always Free Eligible*)
   - **Networking**: Select your default VCN & subnet (ensure *Assign a public IPv4 address* is checked).
   - **Save Private Key**: Click **Download Private Key** (`ssh-key-*.key`). Save this on your Windows machine (e.g., `C:\Users\athar\oracle_key.key`).
   - **Boot Volume**: Set size to `200 GB` (100% Free).
4. Click **Create**.

---

## 2. Open Ingress Firewall Ports (Critical)

By default, Oracle Cloud blocks incoming HTTP/HTTPS traffic at the network level.

1. In the Oracle Console, go to **Networking ➔ Virtual Cloud Networks**.
2. Click on your active **VCN** ➔ click **Security Lists** (left menu) ➔ click **Default Security List for vcn-xxxx**.
3. Click **Add Ingress Rules**:
   - **Source CIDR**: `0.0.0.0/0`
   - **IP Protocol**: `TCP`
   - **Destination Port Range**: `80,443,3001,6443`
   - **Description**: `ATH IDE Web, HTTPS, WebSocket, K8s API`
4. Click **Add Ingress Rules**.

---

## 3. Connect via SSH from Windows PowerShell

Open PowerShell on your Windows PC and run:
```powershell
# Set file permissions if needed (replace path with your downloaded key)
ssh -i "C:\Users\athar\oracle_key.key" ubuntu@YOUR_ORACLE_PUBLIC_IP
```

---

## 4. Run the 1-Click Setup & Deployment Script

Once connected to your Oracle Cloud VM, clone your repo and run the automated setup:

```bash
# 1. Clone repository
git clone https://github.com/your-username/vscode-cli.git ath-ide
cd ath-ide

# 2. Run automated server provisioner (installs Docker, K3s, configures firewall)
chmod +x ./k8s/oracle-setup.sh ./k8s/deploy.sh
./k8s/oracle-setup.sh

# 3. Build the container on ARM64
sudo docker build -t ath-ide:latest .

# 4. Deploy to Kubernetes
./k8s/deploy.sh
```

---

## 5. Verify Your Live Deployment

Check your Kubernetes cluster and pod status:
```bash
kubectl get pods -n ath-ide
kubectl get svc -n ath-ide
kubectl get hpa -n ath-ide
```

Open your browser and navigate to:
```text
http://YOUR_ORACLE_PUBLIC_IP:3001
```

🎉 **Your ATH IDE is now live 24/7 in the cloud on 24 GB of RAM with dynamic Kubernetes container sandboxing!**
