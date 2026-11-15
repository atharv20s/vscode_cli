output "worker_endpoint" {
  value       = "http://${aws_lb.worker.dns_name}:8081"
  description = "Private NLB endpoint; configure EXECUTION_WORKER_URL on the API service"
}

output "worker_security_group_id" {
  value       = aws_security_group.worker.id
  description = "Security group assigned to the private execution-worker instances"
}

output "worker_autoscaling_group_name" {
  value       = aws_autoscaling_group.worker.name
  description = "Dedicated execution-worker Auto Scaling Group"
}

output "worker_instance_role_arn" {
  value       = aws_iam_role.worker.arn
  description = "EC2 role for SSM, bootstrap secret read and scoped S3/KMS access"
}
