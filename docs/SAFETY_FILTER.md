# Python content filter

The legacy Python agent now has deterministic screening for common instruction
override attempts, safety-bypass requests, credential-exfiltration language,
remote-shell pipelines and credential-shaped output.

The filter returns structured ALLOW/WARN/BLOCK results. It never returns the
matched secret value. Strict mode escalates instruction-risk matches from WARN
to BLOCK. Oversized and non-text inputs fail closed.

This is deliberately defense-in-depth: regex screening cannot reliably
understand prompt injection, and a WARN is not an approval. The agent must
continue to treat repository files, tool output and retrieved content as
untrusted data. Runtime permissions, per-workspace isolation and human approval
remain independent enforcement controls.

Run the focused tests with:

```bash
python -m unittest safety.test_filter
```
