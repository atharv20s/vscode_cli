---
name: agentic-self-healing
description: Systematic error diagnosis, root-cause isolation, compiler/linter error feedback loops, and atomic regression-free bug repairs.
---

# Agentic Self-Healing & Diagnostic Recovery

Use when diagnosing compiler errors, failing tests, runtime exceptions, or linter diagnostics during agent execution.

## Core Rules
1. **Analyze Evidence First:** Read the exact error output, stack trace, and file line numbers before making edits. Do not guess root causes.
2. **Minimal Atomic Repairs:** Make surgical, targeted fixes to the source of the defect rather than rewriting large sections of working code.
3. **Preserve Surrounding Conventions:** Keep the existing coding style, variable conventions, and architectural patterns of the target repository.
4. **Iterative Verification:** Immediately re-run the specific failing check (`verify_workspace`, test, or linter) after applying the patch.
5. **No Blind Retries:** If a repair attempt fails twice, step back, re-read the relevant source files or dependencies, and re-assess assumptions.
