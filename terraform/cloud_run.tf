# Cloud Run application service. The runtime receives secrets through Secret
# Manager references rather than plaintext Terraform variables.
resource "google_cloud_run_v2_service" "ath_ide_service" {
  provider = google
  name     = var.app_name
  location = var.region
  ingress  = var.allow_public_access ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    service_account = google_service_account.runtime.email

    scaling {
      min_instance_count = 1
      max_instance_count = 10
    }

    containers {
      image = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.docker_repo.repository_id}/ath-ide:${var.image_tag}"

      ports {
        container_port = 3001
      }

      resources {
        limits = {
          cpu    = "2"
          memory = "2Gi"
        }
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "PORT"
        value = "3001"
      }

      dynamic "env" {
        for_each = google_secret_manager_secret.application
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value.secret_id
              version = "latest"
            }
          }
        }
      }

      startup_probe {
        initial_delay_seconds = 5
        timeout_seconds       = 3
        period_seconds        = 10
        failure_threshold     = 3
        http_get {
          path = "/api/health"
          port = 3001
        }
      }

      liveness_probe {
        timeout_seconds   = 3
        period_seconds    = 15
        failure_threshold = 3
        http_get {
          path = "/api/health"
          port = 3001
        }
      }
    }
  }

  depends_on = [
    google_project_service.enabled_apis,
    google_artifact_registry_repository.docker_repo,
    google_secret_manager_secret_iam_member.runtime_accessor,
  ]
}

# Public invocation is opt-in; Cloud Run IAM and ingress remain private by default.
resource "google_cloud_run_v2_service_iam_member" "public_access" {
  count    = var.allow_public_access ? 1 : 0
  provider = google
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.ath_ide_service.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
