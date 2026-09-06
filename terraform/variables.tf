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

variable "image_tag" {
  description = "Docker image tag to deploy"
  type        = string
  default     = "latest"
}

variable "database_url" {
  description = "Neon Serverless PostgreSQL connection string"
  type        = string
  sensitive   = true
  default     = ""
}

variable "redis_url" {
  description = "Redis Cloud connection string for distributed cluster state"
  type        = string
  sensitive   = true
  default     = ""
}

variable "openrouter_api_key" {
  description = "OpenRouter API Key for multi-model failover"
  type        = string
  sensitive   = true
  default     = ""
}

variable "jwt_secret" {
  description = "JWT Secret for user and guest sessions"
  type        = string
  sensitive   = true
  default     = "dev-jwt-secret-override-in-production-cluster-32"
}

variable "domain_name" {
  description = "Optional custom domain name for Cloud DNS and SSL"
  type        = string
  default     = ""
}
