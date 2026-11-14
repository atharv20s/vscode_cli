# Terraform identity and secret rollout

## Keyless CI identity

GitHub Actions authenticates to Google Cloud using GitHub OIDC and Workload
Identity Federation. No service-account JSON key is generated, output, or
stored in GitHub Secrets. The provider condition is restricted to
`var.github_repository` and `refs/heads/var.github_actions_branch`.

Configure the deployment workflow with the Terraform output
`workload_identity_provider`, the deployer service-account email and
`permissions: id-token: write`. The deployer receives Artifact Registry
writer, Cloud Run admin and GKE developer roles. Service Account User is
scoped to the Cloud Run runtime service account instead of the whole project.

## Runtime secrets

Terraform creates Secret Manager secret containers and grants the dedicated
Cloud Run runtime identity access. It intentionally does not create secret
versions or put credential values in variables, plans, outputs or state.

Before deploying Cloud Run, create version 1 for each secret (replace the
prefix if `var.app_name` changes):

- `ath-ide-database-url`
- `ath-ide-redis-url`
- `ath-ide-openrouter-api-key`
- `ath-ide-jwt-secret`

Populate values through a trusted secret-management workflow, not
`terraform.tfvars`. Cloud Run cannot start until each referenced secret has
an enabled version.

## State migration

The old configuration generated `google_service_account_key.deployer_key`
and exported its private key. After verifying the new OIDC path, revoke/delete
the old key in IAM and rotate any credential copied into CI secrets. Existing
Terraform state and state backups may retain the old private key; treat them
as sensitive and follow your state-retention procedure.

The public Cloud Run invoker remains enabled because the product serves a
public IDE shell. Application data and workspace APIs must continue enforcing
application authentication and authorization.
