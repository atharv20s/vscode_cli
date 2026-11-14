variable "project_id" {
  description = "The Google Cloud Platform Project ID"
  type        = string
}

variable "region" {
  description = "GCP Region for deployment"
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "GCP Zone for primary compute instances"
  type        = string
  default     = "us-central1-a"
}

variable "app_name" {
  description = "Application and resource naming prefix"
  type        = string
  default     = "ath-ide"
}

variable "github_repository" {
  description = "GitHub owner/repository allowed to federate into the deployer service account"
  type        = string
  default     = "atharv20s/vscode_cli"
}

variable "github_actions_branch" {
  description = "Only this Git ref may exchange GitHub OIDC tokens for deployer credentials"
  type        = string
  default     = "main"
}

variable "image_tag" {
  description = "Docker image tag to deploy"
  type        = string
  default     = "latest"
}

variable "domain_name" {
  description = "Optional custom domain name for Cloud DNS and SSL"
  type        = string
  default     = ""
}
