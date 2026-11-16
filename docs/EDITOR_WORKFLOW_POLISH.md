# Editor workflow polish

This branch adds five usability and diagnostics improvements on top of the existing editor, split-pane, symbol-outline, and terminal-session work.

## Changes

- Git diff overlay can switch between side-by-side and inline rendering without refetching the file.
- Split editor groups have a keyboard-accessible draggable sash with a 25–75% resize range.
- Symbol Outline includes a subsequence-based fuzzy filter and accepts `@symbol` queries.
- Workspace diagnostics combine Tree-sitter parse findings with optional isolated ESLint (JavaScript) or Ruff (Python) checks when the corresponding executable is installed. The linter receives source over stdin, uses fixed arguments, ignores project config, runs without a shell, and is time-limited/output-capped. No linter is downloaded or installed automatically.
- Terminal tabs can be double-clicked to rename them; Enter or blur saves and Escape cancels.

## Verification boundary

GitHub Actions validates the committed code. Browser interaction, live worker execution, and actual availability of ESLint/Ruff in the deployed runtime still require environment-level acceptance testing.
