# ATH IDE GCP Terraform deployment

## Security model

- GitHub Actions authenticates to GCP using OIDC Workload Identity Federation.
  No long-lived service-account JSON key is generated or exported.
- The provider trusts only `var.github_repository` on `refs/heads/main`.
- Cloud Run runs as a separate runtime service account.
- `DATABASE_URL`, `REDIS_URL`, `OPENROUTER_API_KEY` and `JWT_SECRET` are
  Secret Manager references. Terraform creates empty secret containers only;
  secret payloads never enter Terraform variables, plans or state.
- Cloud Run public ingress and unauthenticated invocation are disabled by
  default. Set `allow_public_access=true` only when the application is ready
  to enforce its own authentication.
- GKE is optional and disabled by default to avoid provisioning billable nodes.
- This module does not create a load balancer. The optional DNS resource is a
  managed zone only; do not point an A record at an IP without a real backend.

## Populate secrets

After applying Terraform, populate the secret IDs from the
`application_secret_ids` output. Use your secret manager or a secure operator
shell; do not put secret values in `terraform.tfvars` or commit them.

Example (repeat for each secret and never echo the value):

```bash
printf %s "$DATABASE_URL" | gcloud secrets versions add ath-ide-database_url --data-file=-
printf %s "$REDIS_URL" | gcloud secrets versions add ath-ide-redis_url --data-file=-
printf %s "$OPENROUTER_API_KEY" | gcloud secrets versions add ath-ide-openrouter_api_key --data-file=-
printf %s "$JWT_SECRET" | gcloud secrets versions add ath-ide-jwt_secret --data-file=-
```

The runtime service account receives `roles/secretmanager.secretAccessor` on
these four secrets. Rotate values by adding a new secret version; do not bake
them into the container image.

## GitHub Actions authentication

Grant the workflow permission `id-token: write` and exchange its OIDC token
using the output `github_workload_identity_provider` and
`github_actions_service_account_email`. No `GCP_SA_KEY` secret is used.
The Terraform provider condition rejects forks, other repositories and refs
other than `refs/heads/main`.

The deployer has Artifact Registry writer on the application repository,
Cloud Run developer and service usage permissions. GKE developer permissions
are added only when `enable_gke=true`. The deployer can act as the dedicated
Cloud Run runtime service account, but the runtime identity is not a deployer.

## Review before apply

Run `terraform fmt -recursive`, `terraform init -backend=false`,
`terraform validate`, and inspect `terraform plan` before applying. Enabling
public ingress, creating GKE or changing the region can have security and cost
implications. Terraform cannot roll back external database schema changes.
