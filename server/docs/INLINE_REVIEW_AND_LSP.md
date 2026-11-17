# Ambient Agent, Inline Edit and Recovery

## Agent modalities

### Composer

Composer remains the workspace-level autonomous agent. Before each owner Composer request, the browser asks the workspace API to create a pre-run recovery snapshot. The agent request is not sent if snapshot creation fails. If the agent proposes changes for review, the snapshot stays open until the user applies or rejects the proposal; it is finalized only after that decision.

### Inline Edit

- Ctrl/Cmd+K opens a focused prompt inside the active Monaco editor.
- The request captures the active file, language, cursor, selection, selected text, buffer contents and expected disk version.
- The authenticated /ws connection carries a dedicated inline.edit request. The server checks owner permission, workspace path boundaries, request sizes and the expected file version.
- Inline Edit calls the configured fast LLM tier with no tools and a single focused replacement task. It cannot call Composer tools or write workspace files.
- Text deltas stream into an editable preview surface, never directly into the Monaco model. The replacement is applied to the captured Monaco range only after the user accepts it. The buffer must still have the same model version; otherwise acceptance is refused.
- Open in Composer transfers the focused instruction and live editor context to the normal Composer input.

### Ambient context

Composer requests now include the active file, language, cursor, selection, selected text, open files, recent edit summaries and the current document's indexed symbols. Context is bounded before it is sent. Source text remains untrusted input and does not grant tools or permissions.

### Tab completion

Monaco inline completions use a separate authenticated /api/workspace/inline-completion endpoint and the configured fast model tier. Requests are throttled per user, bounded by file/context size and aborted after a short timeout. The response includes observed latency and rolling p50/p95 samples; there is no 150 ms latency guarantee. A fast model must be configured for the provider or completions remain unavailable rather than silently downgrading.

## Multi-hunk Agent Apply review

Agent Apply compares original and proposed file contents with a bounded line diff and creates independent Monaco View Zones. Each hunk can be accepted or rejected separately. The replacement text is editable in the hunk zone before acceptance. Accepted hunks are composed against the original file and committed through the existing version-checked endpoint. Unaccepted hunks remain available after partial commits; a version conflict blocks the commit instead of overwriting newer file contents.

The diff helper uses bounded LCS for ordinary files and a bounded prefix/suffix fallback for very large inputs. It does not stream raw unified-diff text into Monaco. Inline Edit likewise keeps streamed tokens in a preview until the complete replacement is ready.

## Agent-run snapshots and rollback

Owner-only API endpoints create, finalize and roll back a run snapshot.

- Captures regular workspace files, untracked files, empty directories, symlinks, file modes and modification times, plus the Git index when the workspace has a regular .git directory.
- Captures up to 40 open editor buffers, active tab/group, dirty flags and file versions (3 MB total editor-buffer limit).
- Snapshot budget: 10,000 entries and 100 MiB per workspace snapshot. node_modules, common build/cache directories, .git contents (except the index) and the private snapshot store are excluded.
- Keeps at most 10 completed snapshots per workspace; abandoned incomplete snapshots expire after 24 hours.
- Rollback compares the current workspace manifest and Git index with the post-run manifest. If anything changed after the run, rollback refuses rather than overwriting newer user work.
- A successful rollback restores workspace files, the Git index and the captured editor buffers. Git object data and refs are not rewritten; this is a workspace/index restore, not a full Git repository transaction.

The snapshot directory is reserved by the workspace path resolver and stored with private directory permissions. The feature is a single API-instance local-disk implementation; multi-node deployments need shared snapshot storage and coordinated run ownership before horizontal scale.

## Frontend modularization

The first extraction steps are agentState.js (an observable, validated agent state machine) and agentContext.js (bounded editor context and editor-buffer snapshot capture/restore). The legacy app.js and editor.js remain classic browser scripts for compatibility with the current static deployment. A full Vite/TypeScript bundle migration is not part of this change; it should be staged after the module boundaries and CI build pipeline are established.

## Verification boundaries

- Unit tests cover the snapshot lifecycle, Git-index restoration, rollback conflict refusal and agent-state transitions.
- Inline Edit and Tab completion still require a configured fast-tier LLM provider for live model calls.
- Browser acceptance, multi-user concurrency, remote-worker rollback drills and production deployment must be run in the target environment before enabling this for production tenants.
