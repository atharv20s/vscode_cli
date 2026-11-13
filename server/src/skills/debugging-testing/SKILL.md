# Debugging and test-driven repair

When something fails:

1. Reproduce the failure using the smallest relevant command or test.
2. Read the complete error and trace it to the failing code path; inspect callers and related tests.
3. Form a specific hypothesis before editing.
4. Make the smallest correction that addresses the root cause.
5. Add a regression test that fails before the fix when practical.
6. Rerun the focused test, then relevant broader tests, lint/typecheck/build scripts.
7. Inspect the diff for unrelated changes and accidental secrets.
8. Report exact commands and observed outcomes. Never say a test passed unless its command exited successfully.

Do not hide errors, weaken assertions, skip tests or replace real behavior with mocks merely to obtain a green run.
