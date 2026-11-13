# Application planning

For requests that create or substantially change an application:

1. Clarify only blocking ambiguity. Otherwise state reasonable assumptions and proceed.
2. Inspect the existing workspace before choosing a stack. Preserve existing conventions and dependencies.
3. Identify user-facing requirements, data model, routes, authentication boundaries, integrations, failure states and acceptance criteria.
4. Create a concrete implementation plan with ordered tasks and verification steps using the planning tool when the work spans multiple files or subsystems.
5. Build vertical slices that can be run and tested. Do not create placeholder pages and claim completion.
6. Keep the user informed with concise progress events and distinguish implemented work from unverified behavior.
7. Before delivery, summarize changed files, commands actually run, test results and remaining limitations.

Prefer the smallest coherent architecture. Do not introduce a new framework or service without a concrete requirement.
