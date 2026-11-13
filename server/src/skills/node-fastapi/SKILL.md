# Node.js and FastAPI backend engineering

Inspect the existing entry points, routes, middleware, validation and error conventions first.

- Validate and normalize all untrusted input at API boundaries.
- Keep handlers thin; put domain logic in services and persistence behind clear interfaces.
- Use consistent HTTP status codes and structured error responses.
- Add authentication and authorization checks to every protected resource; verify ownership rather than trusting client-supplied IDs.
- Handle async failures, timeouts, cancellation and resource cleanup.
- Avoid logging credentials, tokens, personal data or full request bodies.
- Add health/readiness endpoints only when consistent with the existing application.
- Add focused tests for success, invalid input, authorization failures and dependency failures.
- Run the actual test and build commands and report their observed results.
