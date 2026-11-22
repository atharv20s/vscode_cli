---
name: typescript-architecture
description: Professional TypeScript engineering patterns, strict type-safety, project references, interfaces, discriminated unions, and tsconfig hygiene.
---

# TypeScript Architecture & Engineering

Use when designing, writing, or refactoring TypeScript codebases across frontend, backend, or full-stack projects.

## Core Rules
1. **Strict Type-Safety:** Respect `strict: true`. Avoid `any`; prefer `unknown` with type narrowing, generics, or discriminated union patterns.
2. **Explicit Contracts:** Define clear interfaces or types for domain models and API boundaries. Avoid inline anonymous complex types.
3. **Module Resolution:** Align imports with `moduleResolution` in `tsconfig.json` (e.g., `NodeNext` requires `.js` extensions for ESM imports).
4. **Error Handling:** Use typed error classes or Result/Either patterns rather than untyped throws.
5. **Compilation Verification:** Always run `npm run typecheck` or `tsc --noEmit` before concluding any TypeScript implementation task.
