# Optional Cloud DNS managed zone. No A record is pointed at a dangling
# static address: this module does not provision a load balancer. Complete the
# Cloud Run domain mapping and add the exact records returned by Google after
# domain ownership is verified.
resource "google_dns_managed_zone" "dns_zone" {
  count       = var.domain_name != "" ? 1 : 0
  provider    = google
  project     = var.project_id
  name        = "${var.app_name}-dns-zone"
  dns_name    = "${var.domain_name}."
  description = "DNS zone for ATH IDE; Cloud Run domain records are configured after verification."

  depends_on = [google_project_service.enabled_apis]
}
