variable "aws_region" {
  description = "AWS region for workspace snapshots"
  type        = string
  default     = "ap-south-1"
}

variable "bucket_name" {
  description = "Globally unique private S3 bucket name; set explicitly before apply"
  type        = string
}

variable "name_prefix" {
  description = "Prefix for the IAM policy name"
  type        = string
  default     = "ath-ide"
}

variable "kms_key_arn" {
  description = "Optional customer-managed KMS key ARN. Empty uses S3-managed AES256 encryption."
  type        = string
  default     = ""
}

variable "noncurrent_version_retention_days" {
  description = "Days to retain superseded workspace snapshot versions"
  type        = number
  default     = 30
  validation {
    condition     = var.noncurrent_version_retention_days >= 1 && var.noncurrent_version_retention_days <= 3650
    error_message = "Version retention must be between 1 and 3650 days."
  }
}

variable "tags" {
  description = "Additional resource tags"
  type        = map(string)
  default     = {}
}
