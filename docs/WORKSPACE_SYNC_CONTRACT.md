# Remote workspace synchronization contract

**Baseline:** `f0a4c8525d1129ed68dea8eb34118b96e957a5ed` on `main`.

## Current behavior confirmed in the API client

1. `WorkspaceService` owns the API-side workspace root and validates paths for API file operations.
2. `collectWorkspaceFiles(root)` recursively snapshots regular files while skipping symlinks and ignored directories (`.git`, `node_modules`, `.next`, build/cache directories).
3. Snapshot bounds are 4,000 files, 2 MiB per file and 12 MiB total.
4. `syncWorkspaceOnRemote` sends the API-side snapshot to `POST /v1/workspace/sync`.
5. `executeOnRemoteWorker` sends the current API snapshot with `POST /v1/execute`, then applies the returned full file list back to the API workspace.
6. `pullWorkspaceFromRemote` fetches a full worker snapshot. If the remote snapshot is empty while the local workspace is non-empty, it initializes the remote from local rather than deleting local files.
7. `applyWorkspaceFiles` validates all returned paths/content before applying them, removes local regular files missing from the returned snapshot, and writes changed files through temporary files plus rename.

## Authority is not yet a proven distributed invariant

The observable API-side sequence is:

```text
API workspace snapshot
  -> remote worker receives snapshot
  -> command runs against worker workspace
  -> worker returns full snapshot
  -> API applies returned snapshot
```

That makes the API copy the input state at operation start and the worker response the state applied after execution. The helper contract alone does **not** prove safe concurrent authority:

- No compare-and-swap version or snapshot generation is included in the shown request/response payload.
- These helpers do not acquire a per-workspace lock around collect -> remote operation -> apply.
- Two overlapping operations can collect the same base state, execute concurrently, and apply results in completion order rather than user-intent order.
- A stale worker response can therefore overwrite newer API-side edits unless another layer prevents the race.
- Full-snapshot deletion is meaningful: any regular local file absent from the returned worker snapshot is removed.
- The current transfer limits mean larger workspaces need a different shared/persistent mount strategy; they are not silently partially synced.

This is a risk statement about the inspected client-side code, not a claim that a race has been reproduced in production. The worker-side endpoint implementation and any outer locks must also be inspected before declaring the full system unsafe or safe.

## Desired authority contract

For a single workspace, the target contract should be:

1. API workspace state has a monotonically increasing generation.
2. A worker operation claims that generation with a unique operation/lease ID.
3. The worker executes only against that generation and returns a manifest plus changed-file set (not an unqualified whole-workspace replacement).
4. API applies the result only if the workspace generation and operation lease still match.
5. A stale result is rejected as a conflict and surfaced to the caller; it never silently overwrites a newer save.
6. Terminal sessions, previews and background agents share the same workspace serialization/fencing policy or explicitly declare read/write concurrency.
7. Worker restart/recovery rehydrates from the latest committed API generation; partial transfer never becomes an authoritative snapshot.
8. File deletion is explicit in the returned manifest/delta and version-checked like writes.

## Acceptance tests required

- Push and pull a nested workspace with empty directories, symlinks and ignored folders.
- Confirm deletion propagation is intentional and scoped only to managed workspace files.
- Reject traversal paths, malformed base64, oversized file/count/total payloads before any mutation.
- Interrupt upload, execution and download at each boundary; retry without partial authority changes.
- Race two operations from the same base generation; only one may commit, the other must receive a conflict.
- Race a user save against a returning worker snapshot; the save must not be overwritten by stale worker state.
- Restart a worker during an operation and prove rehydration from the last committed generation.
- Run the same cases across two API instances to prove the lock/fencing is distributed, not process-local.

## Current change scope

PR #67 adds local tests for the API snapshot collection/application helpers. It does not implement distributed locking, version fencing, worker endpoint changes or production migration. Those should be separate implementation steps after the worker-side contract is inspected.
