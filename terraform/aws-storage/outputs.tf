output "bucket_name" {
  value       = aws_s3_bucket.workspace_snapshots.bucket
  description = "Private workspace snapshot bucket name"
}

output "bucket_arn" {
  value       = aws_s3_bucket.workspace_snapshots.arn
  description = "Workspace snapshot bucket ARN"
}

output "worker_policy_arn" {
  value       = aws_iam_policy.workspace_worker.arn
  description = "Attach this policy to the dedicated worker role; do not attach it to the API or user identities"
}
