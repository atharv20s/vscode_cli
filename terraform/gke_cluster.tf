# Google Kubernetes Engine (GKE) Cluster — Dedicated Distributed Pod Orchestration
resource "google_container_cluster" "primary" {
  provider                 = google
  name                     = "${var.app_name}-gke-cluster"
  location                 = var.region
  remove_default_node_pool = true
  initial_node_count       = 1

  # Network configuration
  network    = "default"
  subnetwork = "default"

  ip_allocation_policy {
    # VPC-native cluster
  }

  release_channel {
    channel = "REGULAR"
  }

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  depends_on = [google_project_service.enabled_apis]
}

# Node Pool with Auto-scaling (1 to 5 e2-medium or e2-standard-2 nodes)
resource "google_container_node_pool" "primary_nodes" {
  provider   = google
  name       = "${var.app_name}-node-pool"
  location   = var.region
  cluster    = google_container_cluster.primary.name
  node_count = 2

  autoscaling {
    min_node_count = 1
    max_node_count = 5
  }

  node_config {
    machine_type = "e2-medium"
    disk_size_gb = 30
    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform"
    ]

    labels = {
      app = var.app_name
      env = "production"
    }

    tags = ["gke-node", "${var.app_name}-node"]
  }
}
