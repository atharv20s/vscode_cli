# Empty Secret Manager containers only. Secret payloads are deliberately
# managed out of band (Console, gcloud, or a secret-rotation pipeline) so their
# values never enter Terraform plans, state files, or Git history.
locals {
  application_secret_names = toset([
    "DATABASE_URL",
    "REDIS_URL",
    "OPENROUTER_API_KEY",
    "JWT_SECRET",
  ])
}

resource "google_secret_manager_secret" "application" {
  for_each  = local.application_secret_names
  project   = var.project_id
  secret_id = "${var.app_name}-${lower(each.key)}"

  replication {
    auto {}
  }

  labels = {
    application = var.app_name
    managed-by  = "terraform"
  }

  depends_on = [google_project_service.enabled_apis]
}

resource "google_secret_manager_secret_iam_member" "runtime_accessor" {
  for_each  = google_secret_manager_secret.application
  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}
