# Google Artifact Registry — Docker Container Repository
resource "google_artifact_registry_repository" "docker_repo" {
  provider      = google
  project       = var.project_id
  location      = var.region
  repository_id = "${var.app_name}-repo"
  description   = "Docker container registry for ATH IDE distributed builds"
  format        = "DOCKER"

  depends_on = [google_project_service.enabled_apis]
}
