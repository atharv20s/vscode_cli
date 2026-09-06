# Dedicated Service Account for GitHub Actions CI/CD Pipeline
resource "google_service_account" "github_actions_sa" {
  provider     = google
  account_id   = "${var.app_name}-github-deployer"
  display_name = "ATH IDE GitHub Actions Deployer"
  description  = "Service account used by GitHub Actions to push images and deploy to GCP"
  project      = var.project_id

  depends_on = [google_project_service.enabled_apis]
}

# IAM Roles assigned to GitHub Actions Service Account
locals {
  deployer_roles = [
    "roles/artifactregistry.writer",
    "roles/run.admin",
    "roles/container.developer",
    "roles/iam.serviceAccountUser",
  ]
}

resource "google_project_iam_member" "deployer_bindings" {
  for_each = toset(local.deployer_roles)
  project  = var.project_id
  role     = each.key
  member   = "serviceAccount:${google_service_account.github_actions_sa.email}"
}

# Generate Service Account Key (for GitHub Secrets: GCP_SA_KEY)
resource "google_service_account_key" "deployer_key" {
  service_account_id = google_service_account.github_actions_sa.name
}
