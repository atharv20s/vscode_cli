# Secret payloads are managed out-of-band; Terraform creates no secret versions.
locals {
  runtime_secret_ids = {
    database_url       = "${var.app_name}-database-url"
    redis_url          = "${var.app_name}-redis-url"
    openrouter_api_key = "${var.app_name}-openrouter-api-key"
    jwt_secret          = "${var.app_name}-jwt-secret"
  }
}

resource "google_secret_manager_secret" "database_url" {
  secret_id = local.runtime_secret_ids.database_url
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled_apis]
}

resource "google_secret_manager_secret" "redis_url" {
  secret_id = local.runtime_secret_ids.redis_url
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled_apis]
}

resource "google_secret_manager_secret" "openrouter_api_key" {
  secret_id = local.runtime_secret_ids.openrouter_api_key
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled_apis]
}

resource "google_secret_manager_secret" "jwt_secret" {
  secret_id = local.runtime_secret_ids.jwt_secret
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled_apis]
}

resource "google_secret_manager_secret_iam_member" "runtime_access" {
  for_each = {
    database_url       = google_secret_manager_secret.database_url.secret_id
    redis_url          = google_secret_manager_secret.redis_url.secret_id
    openrouter_api_key = google_secret_manager_secret.openrouter_api_key.secret_id
    jwt_secret          = google_secret_manager_secret.jwt_secret.secret_id
  }
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}
