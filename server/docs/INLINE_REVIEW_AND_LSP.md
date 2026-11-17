# Inline Agent Review and Language Servers

## Inline agent review

Agent Apply proposals are shown in a Monaco View Zone above the active editor rather than in a modal. Proposed lines are highlighted in the editor. Select a proposed file, stage it with **Accept Hunk** (Ctrl/Cmd+Y), or discard that file with **Reject Hunk** (Ctrl/Cmd+N). Only staged files are sent to the existing version-checked Agent Apply commit endpoint. **Apply & verify** retains the existing post-apply verification flow.

Each proposed file is diffed into independent line-level hunks. Every hunk receives its own Monaco View Zone with an isolated Accept/Reject action. Accepted hunks are composed against the original file and committed through the existing version-checked endpoint; rejected hunks are excluded, and undecided hunks remain available after a partial apply. The diff helper uses bounded LCS for normal files and a bounded prefix/suffix fallback for very large inputs.

## TypeScript and Python LSP

The authenticated workspace WebSocket at `/ws` multiplexes LSP JSON-RPC messages. This intentionally reuses the existing JWT/collaboration authentication and workspace binding rather than creating a second unauthenticated WebSocket endpoint.

- TypeScript / JavaScript: `typescript-language-server --stdio`
- Python: `pyright-langserver --stdio`

The production Docker image installs pinned language-server binaries globally. For a non-Docker development server, install those same binaries globally or configure `ATH_LSP_TYPESCRIPT_BIN` and `ATH_LSP_PYTHON_BIN` to absolute executable paths.

Each authenticated owner connection can run one language server at a time. The server enforces a process cap, uses no shell, provides a reduced environment with the workspace as HOME, bounds LSP frame/buffer sizes, and validates incoming `file:` URIs through the workspace path resolver. Processes are stopped when the owning WebSocket closes.

Monaco currently wires LSP completion, hover, definitions, and published diagnostics for TypeScript, JavaScript, and Python. Language servers are started lazily when a supported file is opened.

## Operational notes

- This is an initial single-process LSP bridge, not a horizontally distributed language-server pool.
- The eight-process cap is per application process; production replicas need a shared admission-control strategy before large-scale multi-tenant rollout.
- The workspace resolver protects URI-based file access, but this does not replace OS/container isolation. Run the IDE and language servers with least-privilege filesystem and network permissions.
- Production deployment and live multi-user acceptance are separate steps and are not performed by this change.
