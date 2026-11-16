# Review-first Agent Apply and verification

The `propose_changes` agent tool emits a bounded multi-file patch proposal but never writes files. The frontend fetches current workspace contents and optimistic versions, then renders a Monaco DiffEditor review. Only the workspace owner can accept or reject a proposal.

Acceptance uses per-file optimistic versions and the existing workspace write service. If a later write fails, earlier writes are rolled back using version checks. This is best-effort recovery, not a filesystem-wide atomic commit; any incomplete rollback is surfaced to the user.

Limits: 20 files, 1 MiB per file, 5 MiB total. Binary content, secret-like paths, generated directories, and paths outside the active workspace are rejected. Shared collaborators cannot use the apply endpoints.

**Accept & verify** runs diagnostics on each accepted file, then starts a bounded agent verification turn. The agent is instructed to inspect changed files, run existing tests/build checks without installing dependencies, and submit any repair as another review-first proposal. It never silently applies a repair.

GitHub CI validates source and tests. Browser acceptance, concurrent multi-user contention, and live worker behavior still require environment-level testing.
