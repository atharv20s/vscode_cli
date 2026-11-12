# ATH IDE AI model routing and context engineering

## Model tiers

ATH IDE no longer maps every coding preset to `openrouter/free`. The pipeline requests a tier:

- `fast`: repository/test summaries and lower-risk analysis.
- `coding`: implementation and repair.
- `reasoning`: planning and independent review.
- `vision`: requests containing image input.

Configure a real model ID for every tier used with the selected provider. For OpenRouter, use the exact model slug shown in the OpenRouter model catalogue. For Mistral Direct, the defaults are configured in `server/src/config/env.js`; override them when your account or provider model catalogue changes.

Example:

```env
DEFAULT_LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=...
OPENROUTER_FAST_MODEL=<provider-model-slug>
OPENROUTER_CODING_MODEL=<provider-model-slug>
OPENROUTER_REASONING_MODEL=<provider-model-slug>
OPENROUTER_VISION_MODEL=<provider-model-slug>
LLM_FALLBACK_PROVIDERS=mistral
MISTRAL_API_KEY=...
```

Fallback providers are opt-in. They must have a configured model for the requested tier. ATH IDE does not silently route production coding work to a free model. Authentication, permission, invalid-model and malformed-request errors stop fallback so configuration problems are visible. Successful requests emit a `model_selected` event with provider, model, tier and fallback status; usage events include the actual provider/model when returned by the API.

## Context budgets

All limits below are token estimates, not character counts:

- `LLM_CONTEXT_WINDOW_TOKENS`: selected model's documented context capacity.
- `LLM_CONTEXT_BUDGET_TOKENS`: maximum input context ATH IDE aims to assemble.
- `LLM_OUTPUT_RESERVE_TOKENS`: space reserved for generated output.
- `LLM_CONTEXT_SAFETY_TOKENS`: margin for message framing, tools and tokenizer differences.

The configured input budget + output reserve + safety margin must remain below the model context window. The current character-to-token estimate is deliberately conservative; provider tokenizers should be integrated for exact counts where available.

## Repository retrieval

The repository context engine:

1. Excludes common generated/dependency folders, symlinks and sensitive credential files.
2. Ranks source and manifest files against the task.
3. Expands selected files by one hop through relative imports.
4. Carries project instruction files and dependency relationships.
5. Includes whole files within the configured context budget rather than cutting code blocks mid-file.
6. Uses smaller role-specific budgets: planner 16K, coder 30K, tester 14K, reviewer 20K and repair 24K tokens, capped by the global budget.

The current import index is lightweight and language-agnostic. It is not a complete compiler-grade call graph or semantic index; Tree-sitter/LSP indexing and vector retrieval remain future improvements.

## Quality gates

Coder and repair roles are instructed to inspect callers, preserve interfaces, make focused diffs and add regression tests. The tester must report command/exit evidence. The reviewer inspects actual changed files and blocks on correctness, security, compatibility or missing-test risks. A task still needs deterministic checks and reviewer approval before PR publication.

## Cost and credentials

Model API keys stay in server/worker secret configuration and are never included in prompts. Choose tier models based on your provider's current pricing and context limits. This change does not create cloud resources or set up billing. Add per-user spend enforcement before enabling unrestricted public access.
