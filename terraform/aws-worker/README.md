# AWS private execution-worker pool

This standalone Terraform root provisions a dedicated, private EC2 execution-worker Auto Scaling Group and an internal Network Load Balancer. It is designed to sit behind an existing VPC and private subnets; it does not create or alter the VPC, NAT gateways, API service or database.

## Security architecture
- EC2 instances have no public IP and no inbound SSH rule. Operator access is through Systems Manager Session Manager.
- IMDSv2 is required, metadata hop limit is one, and instance metadata tags are disabled.
- The worker security group accepts port 8081 only from the internal NLB security group; the NLB accepts traffic only from the API security group.
- The worker process belongs to the Docker group, which is effectively host-root access. Treat each worker instance as a privileged security boundary; never co-locate untrusted application services or expose the Docker socket.
- The worker uses a dedicated instance role. It can read one Secrets Manager bootstrap secret and read/write only the workspace snapshot prefix in the S3 bucket. Optional KMS access is limited to the configured key.
- Root EBS storage is encrypted gp3. The worker bootstrap installs the explicit deny-by-default seccomp profile and hardened systemd unit.
- Auto Scaling uses a CPU target tracking policy; the default pool is 1 to 5 instances.
- Workspace data is expected to persist through the S3 snapshot service; the worker's local workspace root is disposable.

## Prerequisites
- An existing VPC with at least two private subnets across availability zones and working outbound NAT or equivalent egress for package downloads and image builds.
- An API security group in the same VPC. Allow the API to connect to the returned internal worker endpoint on TCP 8081.
- The S3 bucket from terraform/aws-storage.
- A Secrets Manager secret whose SecretString is a JSON object containing WORKER_SHARED_SECRET (32+ characters). Values must be scalar and single-line. Do not include static AWS keys: the worker uses its EC2 instance role via IMDSv2.
- The worker API must be reachable from the API over the private NLB. Set EXECUTION_WORKER_URL to the module output and WORKER_SHARED_SECRET to the same protected value on the API.

## Provision
Configure a remote, encrypted and access-controlled Terraform backend before production use; the module does not configure a shared state backend. Run terraform init, terraform fmt -check, terraform validate and terraform plan from this directory. Review the plan, instance type, desired capacity, private subnet routing and expected monthly costs before terraform apply.

After apply, configure the API with EXECUTION_RUNTIME=remote, the private worker_endpoint output as EXECUTION_WORKER_URL, and the same WORKER_SHARED_SECRET. Keep the API-to-worker route private and allow only the API security group to reach the NLB. The worker NLB health check waits for /healthz. Inspect EC2 instance status, SSM registration, systemd logs and docker inspect before routing production traffic.

## Cost and deployment warning
The default configuration starts one t3.large instance, an internal NLB and an Auto Scaling Group. NAT data processing, EC2 hours, EBS, NLB capacity and S3/KMS charges are billed by AWS. This module is opt-in and no resources are created by CI or by opening a pull request. Do not apply it to production without reviewing cost, VPC connectivity, secret contents and the rollback plan.

The bootstrap fetches the repository branch specified by repository_branch (default main), installs Node.js 22, installs locked server dependencies as the unprivileged ubuntu user, builds the workspace image, installs the seccomp profile and starts the execution-worker systemd unit. Treat the Git branch as a release input; use a reviewed immutable release branch or commit before production rollout.