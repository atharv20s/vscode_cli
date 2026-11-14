# ATH IDE implementation and acceptance status

This document separates repository implementation from production evidence. A merged PR or green CI job does not establish that the corresponding feature is active on a live worker.

## Code delivered in the integration branch

| Area | Repository implementation | Verification still required |
|---|---|---|
| Linux sandbox | Explicit Docker seccomp profile, no-new-privileges, dropped capabilities, read-only rootfs, no-network workspace containers, resource limits and hardened systemd worker | Run runtime:verify-workspace-security on each Linux worker; adversarial isolation tests |
| Runtime observability | Authenticated Linux process/cgroup diagnostics and Studio Runtime panel | Compare telemetry with docker inspect and actual worker cgroup configuration |
| Agent orchestration | JavaScript lifecycle hooks, specialist delegation, bounded Python subagents and tool registry | Full multi-agent task integration, retries/cancellation and load testing |
| Safety | Server-owned safety prompt, Python content screening, tool approval gates and permission engine | Adversarial prompt-injection suite and approval UX tests across every tool path |
| Remote access | Strict SSH host-key checking and remote workspace path confinement | Verify host keys and run tests against a disposable remote worker |
| Kubernetes | Restricted Pod Security, non-root, seccomp RuntimeDefault, dropped capabilities, read-only rootfs, ClusterIP service and PDB | Apply to a staging cluster and verify pods start with the production image/volumes |
| AWS worker pool | Private EC2 Auto Scaling Group, internal NLB restricted to API SG, SSM-only administration, IMDSv2 instance role and encrypted EBS | Apply in a staging VPC with NAT, API SG and secret; verify bootstrap, SSM, target health and failover |
| S3 storage | Versioned private bucket Terraform, TLS-only policy, SSE-S3/SSE-KMS, object integrity and STS session-token signing | Terraform plan/apply, then storage:verify-s3 and storage:verify-s3-restore |
| Database recovery | Existing encrypted Neon backup/restore and identity/count audit scripts | Restore to a separate empty branch; compare API/worker DB identities and migration counts |

## Operator acceptance commands

Run from the server directory on the intended Linux worker:

- npm run runtime:verify-workspace-security
- npm run storage:verify-s3
- npm run storage:verify-s3-restore
- npm run production:acceptance

The production acceptance runner includes destructive actions only against random disposable workspaces or explicitly configured empty restore targets. Review each script and environment target before running it. The Neon restore step must target a separate empty database branch.

## Deployment boundary

No AWS account resources, Kubernetes cluster resources, or Lightsail production services are changed by CI or by opening this PR. The AWS storage and worker Terraform modules are standalone opt-in roots; review both plans in the intended account before apply. The S3 client supports environment-delivered STS credentials and EC2 IMDSv2 instance-role credentials; ECS/EKS role credential providers are not implemented.

Production readiness requires successful CI on the final merge commit, a reviewed staging rollout, live Linux enforcement acceptance, S3 restore, database restore, concurrent multi-user isolation, terminal reconnect and browser end-to-end acceptance.