data "google_project" "current" {
  project_id = var.project_id
}

resource "google_service_account" "github_actions_sa" {
  account_id   = "${var.app_name}-github-deployer"
  display_name = "ATH IDE GitHub Actions Deployer"
  description  = "Keyless GitHub Actions identity federated through GitHub OIDC"
  project      = var.project_id
  depends_on   = [google_project_service.enabled_apis]
}

resource "google_service_account" "runtime" {
  account_id   = "${var.app_name}-runtime"
  display_name = "ATH IDE Cloud Run Runtime"
  description  = "Least-privilege identity used by the ATH IDE Cloud Run service"
  project      = var.project_id
  depends_on   = [google_project_service.enabled_apis]
}

resource "google_service_account" "gke_nodes" {
  account_id   = "${var.app_name}-gke-nodes"
  display_name = "ATH IDE GKE Node Identity"
  description  = "Dedicated identity for GKE worker nodes"
  project      = var.project_id
  depends_on   = [google_project_service.enabled_apis]
}

resource "google_project_iam_member" "deployer_bindings" {
  for_each = toset([
    "roles/artifactregistry.writer",
    "roles/run.admin",
    "roles/container.developer",
  ])
  project = var.project_id
  role    = each.key
  member  = "serviceAccount:${google_service_account.github_actions_sa.email}"
}

resource "google_service_account_iam_member" "deployer_can_act_as_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.github_actions_sa.email}"
}

resource "google_project_iam_member" "gke_node_service_agent" {
  project = var.project_id
  role    = "roles/container.defaultNodeServiceAccount"
  member  = "serviceAccount:${google_service_account.gke_nodes.email}"
}

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "${var.app_name}-github"
  display_name              = "ATH IDE GitHub Actions"
  description               = "Federation for the configured GitHub repository and deployment branch"
  depends_on                = [google_project_service.enabled_apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "${var.app_name}-github"
  display_name                       = "ATH IDE GitHub OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  attribute_condition = "assertion.repository == '${var.github_repository}' && assertion.ref == 'refs/heads/${var.github_actions_branch}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "github_workload_identity" {
  service_account_id = google_service_account.github_actions_sa.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/projects/${data.google_project.current.number}/locations/global/workloadIdentityPools/${google_iam_workload_identity_pool.github.workload_identity_pool_id}/attribute.repository/${var.github_repository}"
}
