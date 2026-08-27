#!/bin/bash
# ==============================================================================
# Oracle Cloud Always Free (Ampere ARM64 24GB RAM) — 1-Click Server Provisioner
# ==============================================================================

set -e

echo "🚀 [Oracle Cloud Setup] Initializing Ubuntu on Ampere A1 (24GB RAM)..."

# 1. System Updates & Essential Packages
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget git ufw apt-transport-https ca-certificates gnupg lsb-release

# 2. Configure Host Firewall (iptables / UFW)
echo "🛡️ Opening Ports (80, 443, 3001, 6443)..."
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3001 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 6443 -j ACCEPT
sudo netfilter-persistent save 2>/dev/null || sudo apt install -y iptables-persistent && sudo netfilter-persistent save

# 3. Install Docker
echo "🐳 Installing Docker..."
sudo apt install -y docker.io docker-compose
sudo usermod -aG docker $USER

# 4. Install K3s (Lightweight Kubernetes with Traefik Ingress)
echo "☸️ Installing K3s Kubernetes Cluster..."
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--write-kubeconfig-mode 644" sh -

# Configure local kubeconfig
mkdir -p ~/.kube
sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
sudo chown $USER:$USER ~/.kube/config
export KUBECONFIG=~/.kube/config
echo "export KUBECONFIG=~/.kube/config" >> ~/.bashrc

echo "=============================================================================="
echo "✅ Oracle Cloud Instance Ready!"
echo "Node Status:"
kubectl get nodes -o wide
echo "=============================================================================="
