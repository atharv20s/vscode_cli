# PR #65 — Worker Provisioning & Lifecycle

## Scope

This change introduces the Redis-backed worker registry used by the execution control plane.

- Workers register a bounded identity, HTTPS endpoint, region and capacity.
- A worker record is a short-lived Redis lease; a crashed process disappears after its TTL.
- Heartbeats renew the lease and can transition a worker to `draining`.
- Capacity reservations use Redis Lua scripts, preventing multiple API instances from over-allocating one worker.
- Discovery filters by region and removes expired IDs from the registry index.
- Remote worker URLs require HTTPS; plain HTTP is accepted only for loopback development.

## Safety properties

- No worker is considered schedulable unless its lease exists and status is `healthy`.
- A draining worker cannot accept new reservations.
- Reservation and release are atomic across API instances.
- Registry operations do not own or close the shared Redis connection.
- This registry does not create an unsandboxed execution fallback. Execution must continue through the existing hardened worker runtime.

## Integration boundary

The existing `server/src/worker/executionWorker.js` remains the isolated execution process. The registry is deliberately a control-plane primitive; API route wiring, worker-side authenticated heartbeat reporting, and cloud autoscaling policy should be enabled only with deployment-specific credentials and infrastructure validation. Terraform worker provisioning already exists in `terraform/aws-worker`.

## Validation

Unit tests cover endpoint validation, lease expiry discovery, capacity reservation limits and draining behavior. Run:

```sh
cd server
node --test src/services/workerRegistry.test.js
npm run build
```

A live Redis fault-injection and worker-kill acceptance test is still required before production rollout.
