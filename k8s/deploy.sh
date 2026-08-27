#!/bin/bash
# ==============================================================================
# ATH IDE — 1-Click Kubernetes Deployment Script
# Supports: K3s, Minikube, MicroK8s, EKS, GKE, OCI (Oracle Cloud)
# ==============================================================================

set -e

echo "🚀 [ATH IDE] Deploying to Kubernetes Cluster..."

# 1. Ensure kubectl is available
if ! command -v kubectl &> /dev/null; then
    echo "❌ kubectl not found! Please install kubectl or K3s first."
    exit 1
fi

# 2. Apply Namespace
echo "📦 Applying Namespace..."
kubectl apply -f ./k8s/namespace.yaml

# 3. Apply RBAC
echo "🔐 Applying RBAC Permissions..."
kubectl apply -f ./k8s/rbac.yaml

# 4. Apply ConfigMaps and Secrets
echo "🔑 Applying ConfigMaps & Secrets..."
kubectl apply -f ./k8s/configmap-secrets.yaml

# 5. Apply Persistent Storage
echo "💾 Applying Persistent Storage..."
kubectl apply -f ./k8s/storage.yaml

# 6. Apply Deployment, Service, Ingress, and HPA
echo "⚡ Deploying ATH IDE Core, Service, Ingress, and HPA..."
kubectl apply -f ./k8s/deployment.yaml

echo "=============================================================================="
echo "✅ ATH IDE successfully deployed to Kubernetes namespace: ath-ide"
echo "🔍 Check status with:"
echo "   kubectl get pods -n ath-ide"
echo "   kubectl get svc -n ath-ide"
echo "   kubectl get hpa -n ath-ide"
echo "=============================================================================="
