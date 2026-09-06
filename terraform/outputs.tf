output "cloud_run_url" {
  description = "The live public HTTPS URL for ATH IDE on Google Cloud Run"
  value       = google_cloud_run_v2_service.ath_ide_service.uri
}

output "artifact_registry_repo" {
  description = "Artifact Registry Docker repository endpoint"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.docker_repo.repository_id}"
}

output "gke_cluster_name" {
  description = "The name of the Google Kubernetes Engine cluster"
  value       = google_container_cluster.primary.name
}

output "load_balancer_ip" {
  description = "The static public IP address for Load Balancing"
  value       = google_compute_global_address.lb_ip.address
}

output "service_account_email" {
  description = "GitHub Actions Service Account Email"
  value       = google_service_account.github_actions_sa.email
}

output "service_account_private_key_base64" {
  description = "Base64 encoded Service Account private key for GitHub Secret GCP_SA_KEY"
  value       = google_service_account_key.deployer_key.private_key
  sensitive   = true
}
