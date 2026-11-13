output "cloud_run_url" {
  description = "Cloud Run service URL. Public access is controlled by allow_public_access."
  value       = google_cloud_run_v2_service.ath_ide_service.uri
}

output "cloud_run_ingress" {
  description = "Configured Cloud Run ingress policy."
  value       = google_cloud_run_v2_service.ath_ide_service.ingress
}

output "artifact_registry_repo" {
  description = "Artifact Registry Docker repository endpoint."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.docker_repo.repository_id}"
}

output "gke_cluster_name" {
  description = "Optional GKE cluster name; null when enable_gke is false."
  value       = var.enable_gke ? google_container_cluster.primary[0].name : null
}

output "github_actions_service_account_email" {
  description = "GitHub Actions deployer service account; authenticate with Workload Identity Federation, not a JSON key."
  value       = google_service_account.github_actions_sa.email
}

output "github_workload_identity_provider" {
  description = "Provider resource name to use as the audience/credential provider for GitHub Actions OIDC."
  value       = google_iam_workload_identity_pool_provider.github_actions.name
}

output "runtime_service_account_email" {
  description = "Cloud Run runtime service account."
  value       = google_service_account.runtime.email
}

output "application_secret_ids" {
  description = "Secret Manager secret IDs; secret payloads are populated separately and are not stored in Terraform state."
  value       = { for key, secret in google_secret_manager_secret.application : key => secret.secret_id }
}

output "cloud_dns_nameservers" {
  description = "Cloud DNS nameservers; configure delegation and Cloud Run verified domain records separately."
  value       = var.domain_name != "" ? google_dns_managed_zone.dns_zone[0].name_servers : []
}
