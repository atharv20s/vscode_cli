# AWS workspace snapshot storage

This standalone Terraform root provisions a private S3 bucket for ATH IDE workspace snapshots and a least-privilege IAM policy for a dedicated worker role.

## Security properties
- S3 Block Public Access and bucket-owner-enforced object ownership.
- Versioning enabled; superseded workspace snapshots are retained for the configured number of days (default 30).
- Server-side encryption is always enabled: S3-managed AES256 by default, or SSE-KMS when kms_key_arn is supplied.
- Bucket policy denies all non-TLS requests.
- Worker policy is restricted to the workspaces/* object prefix and optional configured KMS key.
- Incomplete multipart uploads are aborted after seven days.
- The bucket is not force-destroyed by Terraform.

## Provision
Run terraform init, terraform fmt -check, terraform validate and terraform plan -var='bucket_name=YOUR_GLOBALLY_UNIQUE_BUCKET' from this directory.
Review the plan and apply it only in the intended AWS account. Attach worker_policy_arn only to the dedicated execution-worker IAM role. Do not attach it to the public API role, GitHub deployer or end-user identities.
If using KMS, provision and review the key policy separately and pass its ARN as kms_key_arn.

## Worker environment
- WORKSPACE_OBJECT_STORE_BUCKET: output bucket name.
- WORKSPACE_OBJECT_STORE_REGION: provisioned AWS region.
- WORKSPACE_OBJECT_STORE_SERVER_SIDE_ENCRYPTION: AES256 (default) or aws:kms.
- WORKSPACE_OBJECT_STORE_KMS_KEY_ID: required when using aws:kms.
- WORKSPACE_OBJECT_STORE_ACCESS_KEY_ID and WORKSPACE_OBJECT_STORE_SECRET_ACCESS_KEY: rotated credentials for the worker identity.
- WORKSPACE_OBJECT_STORE_SESSION_TOKEN: STS session token when using temporary credentials.

The current object-store client signs S3-compatible requests directly and supports static or STS temporary credentials. It does not yet obtain credentials from EC2/ECS/EKS role metadata automatically. Do not put long-lived AWS keys in source control or GitHub workflow files; use an approved secret delivery mechanism until role-provider integration is deployed.

## Restore acceptance
After worker environment is configured, run npm run storage:verify-s3 and npm run storage:verify-s3-restore from the server package on the worker host. The latter deletes only a random disposable workspace it creates itself, then exercises the real worker pull/restore endpoint. Run these against the intended test bucket and worker during a controlled window.