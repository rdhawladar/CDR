---
name: new-feature
description: Standard workflow for adding a new full-stack feature. Use when the user asks to "add a feature", "implement X end-to-end", or starts work that touches both frontend and backend.
---

# New Feature Workflow

Follow these phases in order. Don't skip ahead.

## 1. Architect — Decide

Invoke `@architect` if the feature introduces:
- A new library or major dependency
- A new module boundary or service
- A schema change with downstream impact
- A pattern not already established in the codebase

Output: an ADR in `docs/decisions/` if a real decision was made. Otherwise a one-paragraph design note in chat.

## 2. Backend — Build the API

Invoke `@backend-specialist`:
1. Define Zod schemas for input and output (in `src/shared/`).
2. Add/update DB schema and migration.
3. Implement repository → service → route, in that order.
4. Run `pnpm typecheck` + targeted tests.

## 3. Frontend — Build the UI

Invoke `@frontend-specialist`:
1. Wire the typed client (TanStack Query hook).
2. Build the component tree, reusing primitives.
3. Loading + error + empty states for every async UI.
4. Verify in the browser.

## 4. QA — Cover the Edges

Invoke `@qa-engineer`:
1. Unit tests for new pure logic.
2. Integration tests for the new endpoint(s) against a real DB.
3. E2E test only if this is a critical user journey.
4. Run the full suite — no flakes.

## 5. Code Review — Final Pass

Invoke `@code-reviewer`. Address blocking findings. Re-run tests. Then merge.
