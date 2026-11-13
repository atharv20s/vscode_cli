variable "project_id" {
  description = "Google Cloud project ID."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run and optional GKE."
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "Default compute zone (reserved for zonal resources)."
  type        = string
  default     = "us-central1-a"
}

variable "app_name" {
  description = "Lowercase resource naming prefix."
  type        = string
  default     = "ath-ide"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,20}$", var.app_name))
    error_message = "app_name must be 3-21 lowercase letters, numbers or hyphens and start with a letter."
  }
}

variable "image_tag" {
  description = "Immutable application image tag. Prefer a commit SHA over latest."
  type        = string
  default     = "latest"
}

variable "github_repository" {
  description = "Exact owner/repository allowed to use GitHub Actions Workload Identity Federation."
  type        = string
  default     = "atharv20s/vscode_cli"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must be owner/repository."
  }
}

variable "allow_public_access" {
  description = "Allow unauthenticated public ingress to Cloud Run. Enable only when application-level authentication is ready."
  type        = bool
  default     = false
}

variable "enable_gke" {
  description = "Provision the optional GKE cluster and autoscaling node pool. Disabled by default to avoid unexpected compute cost."
  type        = bool
  default     = false
}

variable "domain_name" {
  description = "Optional Cloud DNS managed-zone name. Terraform creates the zone only; custom domain mapping/records must be configured from Cloud Run's verified domain records."
  type        = string
  default     = ""
}
