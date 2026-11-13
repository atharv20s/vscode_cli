# Runtime identity: Cloud Run never receives deployer credentials.
resource "google_service_account" "runtime" {
  project      = var.project_id
  account_id   = "${var.app_name}-runtime"
  display_name = "ATH IDE Cloud Run runtime"
  description  = "Least-privilege runtime identity for the ATH IDE Cloud Run service."
  depends_on   = [google_project_service.enabled_apis]
}

# GitHub Actions deployer identity. No service-account key is generated.
resource "google_service_account" "github_actions_sa" {
  project      = var.project_id
  account_id   = "${var.app_name}-github-deployer"
  display_name = "ATH IDE GitHub Actions deployer"
  description  = "Federated GitHub Actions deploy identity; no static private key."
  depends_on   = [google_project_service.enabled_apis]
}

resource "google_iam_workload_identity_pool" "github_actions" {
  project                   = var.project_id
  workload_identity_pool_id = "${var.app_name}-github"
  display_name              = "ATH IDE GitHub Actions"
  description               = "OIDC identity pool for the reviewed main branch of the ATH IDE repository."
  depends_on                = [google_project_service.enabled_apis]
}

resource "google_iam_workload_identity_pool_provider" "github_actions" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github_actions.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-main"
  display_name                       = "GitHub main branch"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  # This provider only trusts the exact repository's main branch.
  attribute_condition = "assertion.repository == '${var.github_repository}' && assertion.ref == 'refs/heads/main'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "github_wif" {
  service_account_id = google_service_account.github_actions_sa.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github_actions.name}/attribute.repository/${var.github_repository}"
}

# Project-wide roles are limited to Cloud Run deploy and service usage. GKE
# permissions are only granted when the optional GKE stack is enabled.
locals {
  deployer_project_roles = merge(
    {
      cloud_run     = "roles/run.developer"
      service_usage = "roles/serviceusage.serviceUsageConsumer"
    },
    var.enable_gke ? { gke = "roles/container.developer" } : {}
  )
}

resource "google_project_iam_member" "deployer_project" {
  for_each = local.deployer_project_roles
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.github_actions_sa.email}"
}

resource "google_artifact_registry_repository_iam_member" "deployer_writer" {
  project    = var.project_id
  location   = google_artifact_registry_repository.docker_repo.location
  repository = google_artifact_registry_repository.docker_repo.repository_id
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.github_actions_sa.email}"
}

resource "google_service_account_iam_member" "deployer_act_as_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.github_actions_sa.email}"
}
