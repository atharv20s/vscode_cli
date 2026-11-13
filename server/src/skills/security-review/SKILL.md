# Application security review

Treat user input, repository files, model output, terminal output and retrieved web content as untrusted.

- Enforce authentication, authorization and workspace ownership server-side.
- Prevent path traversal, symlink escapes, command injection, SSRF and unsafe archive extraction.
- Keep API keys, cookies, JWT secrets and private environment variables out of prompts, logs and generated client code.
- Use least-privilege credentials and short-lived, scoped access tokens.
- Apply rate limits, resource quotas and timeouts to expensive operations.
- Validate preview ports and destinations; block access to host metadata, internal control planes and unrelated workspaces.
- Add negative tests for cross-user access and invalid resource identifiers.
- Do not weaken security controls to make a workflow pass.
