# Architecture

High-level system overview. Detailed decisions live in `docs/decisions/` as ADRs.

## Stack (defaults — confirm with architect for new projects)

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) | End-to-end type safety |
| Package manager | pnpm | Fast, disk-efficient, strict resolution |
| Frontend | React + Vite (or Next.js for SSR) | Mature, hireable, good DX |
| Styling | Tailwind CSS | Co-located, no naming overhead |
| State (client) | TanStack Query + Zustand | Server state vs UI state, separated |
| Forms | React Hook Form + Zod | Performance + shared validation |
| Backend | Hono on Node.js (or Fastify) | Lightweight, typed, fast |
| Database | Postgres | Boring, reliable, ubiquitous |
| ORM | Drizzle | TypeScript-native, close to SQL |
| Validation | Zod | Single schema for runtime + types |
| Auth | Lucia / Better Auth + cookies | First-party simple, no JWT footguns |
| Testing | Vitest + Playwright | Fast unit, real-browser E2E |
| CI | GitHub Actions | Default, well-supported |

## Folder Layout (suggested)

```
src/
├── web/              # Frontend app
│   ├── components/   # Reusable UI primitives
│   ├── features/     # Feature-scoped components, hooks, API hooks
│   ├── pages/        # Routes (or app/ for Next.js)
│   └── lib/          # Frontend-only utilities
├── server/           # Backend app
│   ├── routes/       # HTTP route handlers (thin)
│   ├── services/     # Business logic
│   ├── repositories/ # DB access
│   ├── db/           # Drizzle schema, migrations
│   └── lib/          # Backend-only utilities
└── shared/           # Types, Zod schemas, constants used by both
```

## Module Boundaries

- **Frontend never imports from `src/server/`.** Use `src/shared/` for cross-boundary types.
- **Routes call services. Services call repositories.** Never the other way.
- **Repositories are the only place SQL/ORM lives.**

## Decision Records

See `docs/decisions/` for ADRs. Each non-trivial choice (framework, library, pattern) gets one.
