# Project Instructions

This is a full-stack TypeScript project. Read this file at the start of every session.

## Tech Stack

- **Language:** TypeScript (strict mode, no `any`)
- **Frontend:** React + Vite (or Next.js when SSR is needed)
- **Backend:** Node.js with a typed framework (Hono / Fastify / NestJS — confirm with architect)
- **Database:** Postgres via a typed ORM (Drizzle or Prisma)
- **Testing:** Vitest for unit, Playwright for E2E
- **Package manager:** pnpm

The architect agent owns final tech decisions — see `@docs/architecture.md`.

## Coding Standards

Keep it readable, not clever.

- **Naming:** descriptive over short. `getUserById` not `get`. `isAuthenticated` not `flag`.
- **Functions:** small and single-purpose. If a function needs a section comment, split it.
- **No premature abstraction:** three similar lines beats a wrong abstraction.
- **No dead code:** delete unused exports, vars, imports immediately.
- **Errors:** throw typed errors at boundaries; let them bubble. Don't wrap-and-rethrow without adding info.
- **Comments:** explain *why*, never *what*. Default is no comment.
- **Imports:** absolute paths from project root (`@/lib/...`), not deep relatives.
- **Types over interfaces** unless you need declaration merging.
- **No `any`, no `as` casts** without a comment justifying them.
- **Async:** `async/await` only, never raw `.then()` chains.

## Workflow

- Use specialist agents for their domain — see `.claude/agents/`.
  - Architect: tech choices, ADRs, system design
  - Frontend specialist: React, UI, accessibility, state
  - Backend specialist: APIs, DB, services, auth
  - QA engineer: tests, edge cases, regressions
  - Code reviewer: pre-merge audit
- Run `pnpm typecheck` and `pnpm test` before declaring work complete.
- For UI work, start the dev server and verify in a browser.

## What Goes Where

- **Architecture decisions:** `docs/decisions/NNNN-title.md` (ADR format)
- **System design notes:** `docs/architecture.md`
- **Bugs and TODOs:** issue tracker (not this file, not random `.md`s)
- **Personal scratch / local URLs:** `CLAUDE.local.md` (gitignored)
- **Reusable workflows:** `.claude/skills/<name>/SKILL.md`

## Imports

@docs/product.md
@docs/architecture.md
