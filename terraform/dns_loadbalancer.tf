# Static Global External IP Address for Load Balancer
resource "google_compute_global_address" "lb_ip" {
  provider = google
  name     = "${var.app_name}-static-ip"
  project  = var.project_id

  depends_on = [google_project_service.enabled_apis]
}

# Optional Cloud DNS Managed Zone
resource "google_dns_managed_zone" "dns_zone" {
  count       = var.domain_name != "" ? 1 : 0
  provider    = google
  name        = "${var.app_name}-dns-zone"
  dns_name    = "${var.domain_name}."
  description = "Managed DNS zone for ATH IDE live domain"

  depends_on = [google_project_service.enabled_apis]
}

# Optional DNS Record Set pointing to Load Balancer IP
resource "google_dns_record_set" "app_record" {
  count        = var.domain_name != "" ? 1 : 0
  provider     = google
  managed_zone = google_dns_managed_zone.dns_zone[0].name
  name         = "${var.domain_name}."
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_global_address.lb_ip.address]
}
