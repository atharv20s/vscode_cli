variable "aws_region" {
  description = "AWS region for the worker pool"
  type        = string
  default     = "ap-south-1"
}

variable "name_prefix" {
  description = "Short resource naming prefix"
  type        = string
  default     = "ath-ide"
}

variable "vpc_id" {
  description = "Existing VPC containing private_subnet_ids"
  type        = string
}

variable "private_subnet_ids" {
  description = "At least two private subnets with outbound NAT or equivalent egress"
  type        = list(string)
  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "Provide at least two private subnets for multi-AZ worker placement."
  }
}

variable "api_security_group_id" {
  description = "Security group attached to the API service; only this group may connect to the worker NLB"
  type        = string
}

variable "worker_secret_arn" {
  description = "Secrets Manager secret ARN containing WORKER_SHARED_SECRET and temporary S3 credential environment values"
  type        = string
}

variable "workspace_bucket_name" {
  description = "S3 bucket name created by terraform/aws-storage"
  type        = string
}

variable "workspace_bucket_arn" {
  description = "S3 bucket ARN created by terraform/aws-storage"
  type        = string
}

variable "kms_key_arn" {
  description = "Optional customer-managed KMS key ARN used for workspace snapshots"
  type        = string
  default     = ""
}

variable "repository_url" {
  description = "Git repository URL for the worker runtime"
  type        = string
  default     = "https://github.com/atharv20s/vscode_cli.git"
}

variable "repository_branch" {
  description = "Branch containing the reviewed worker runtime"
  type        = string
  default     = "main"
}

variable "instance_type" {
  description = "EC2 instance type for Docker workspace workloads"
  type        = string
  default     = "t3.large"
}

variable "workspace_image" {
  description = "Local image tag built from server/Dockerfile.workspace"
  type        = string
  default     = "ath-ide-workspace:worker"
}

variable "root_volume_size_gib" {
  description = "Encrypted gp3 root disk size"
  type        = number
  default     = 60
}

variable "min_size" {
  type    = number
  default = 1
}

variable "desired_capacity" {
  type    = number
  default = 1
}

variable "max_size" {
  type    = number
  default = 5
}

variable "target_cpu_utilization" {
  type    = number
  default = 65
}

variable "tags" {
  type    = map(string)
  default = {}
}
