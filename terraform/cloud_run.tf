# Google Cloud Run v2 Service — Scalable Serverless Multi-Instance Deployment
resource "google_cloud_run_v2_service" "ath_ide_service" {
  provider = google
  name     = var.app_name
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
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
      env {
        name  = "DATABASE_URL"
        value = var.database_url
      }
      env {
        name  = "REDIS_URL"
        value = var.redis_url
      }
      env {
        name  = "OPENROUTER_API_KEY"
        value = var.openrouter_api_key
      }
      env {
        name  = "JWT_SECRET"
        value = var.jwt_secret
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
    google_artifact_registry_repository.docker_repo
  ]
}

# Allow unauthenticated public access so anyone can view the live site
resource "google_cloud_run_v2_service_iam_member" "public_access" {
  provider = google
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.ath_ide_service.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
