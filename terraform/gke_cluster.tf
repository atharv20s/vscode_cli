# Optional GKE stack. Disabled by default to prevent an unexpected
# cluster/node-pool bill for deployments that only use Cloud Run.
resource "google_container_cluster" "primary" {
  count                    = var.enable_gke ? 1 : 0
  provider                 = google
  name                     = "${var.app_name}-gke-cluster"
  location                 = var.region
  remove_default_node_pool = true
  initial_node_count       = 1

  network    = "default"
  subnetwork = "default"

  ip_allocation_policy {}

  release_channel {
    channel = "REGULAR"
  }

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  depends_on = [google_project_service.enabled_apis]
}

resource "google_container_node_pool" "primary_nodes" {
  count      = var.enable_gke ? 1 : 0
  provider   = google
  name       = "${var.app_name}-node-pool"
  location   = var.region
  cluster    = google_container_cluster.primary[0].name
  node_count = 2

  autoscaling {
    min_node_count = 1
    max_node_count = 5
  }

  node_config {
    machine_type = "e2-medium"
    disk_size_gb = 30
    oauth_scopes = ["https://www.googleapis.com/auth/cloud-platform"]

    labels = {
      app = var.app_name
      env = "production"
    }

    tags = ["gke-node", "${var.app_name}-node"]
  }
}
