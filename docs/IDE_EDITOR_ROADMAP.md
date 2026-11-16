# ATH IDE editor roadmap

This document tracks the editor UX implementation sequence. The pull requests are cumulative and should be reviewed and merged in order.

| PR | Feature | Scope |
|---|---|---|
| #51 | Tree-sitter → Monaco Go to Definition and Hover | Workspace-scoped symbol resolution, declaration locations, hover metadata and cached Tree-sitter indexing. |
| #52 | Find-in-Files and Git status decorations | Bounded workspace search, changed-file indicators and Monaco changed-line markers. |
| #53 | Monaco Git diff viewer | Read-only side-by-side comparison of a workspace file against HEAD. |
| #54 | Split editor panes | Independent primary and secondary Monaco editor groups sharing workspace file models. |
| #55 | Inline diagnostics and Problems panel | Tree-sitter syntax diagnostics, Monaco markers and navigable Problems list. |
| #56 | Breadcrumbs and symbol outline | File-path breadcrumbs, active declaration context and per-file symbol navigation. |
| #57 | Multiple terminal sessions | Independent xterm views, PTY session IDs, per-session WebSockets and explicit session close. |
| #58 | Editor workflow polish | Diff viewer inline/side-by-side toggle, split editor draggable sash, symbol outline fuzzy search, semantic diagnostics (ESLint/Ruff), and terminal tab rename. |

## Merge order

Merge #51, then #52, #53, #54, #55, #56, #57, and #58. Each later PR is based on the cumulative feature branch and targets `main`; after its predecessor merges, GitHub should reduce the later PR's diff to its incremental changes.

## Acceptance boundary

A code change or passing CI job is not production acceptance. Browser checks, workspace-isolation checks and live runtime checks must be completed separately before declaring the feature production-ready. No Lightsail deployment is performed by these PRs.
