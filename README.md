# Claude Code Full-Stack Starter

A production-ready **Claude Code template** for building full-stack TypeScript applications with five specialist AI subagents (architect, frontend, backend, QA, code reviewer), pre-configured workflows, and ADR scaffolding.

> **One-line summary:** A reusable GitHub template that bootstraps a Claude Code project with a multi-agent team, coding standards, and architecture documentation — so you stop reinventing your AI dev setup for every new project.

[![Use this template](https://img.shields.io/badge/Use%20this%20template-2ea44f?style=for-the-badge&logo=github)](https://github.com/rdhawladar/claude-code-fullstack-starter/generate)
[![Claude Code](https://img.shields.io/badge/Built%20for-Claude%20Code-D97757?style=for-the-badge)](https://docs.claude.com/en/docs/claude-code)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

---

## Table of Contents

- [What is this?](#what-is-this)
- [Who is this for?](#who-is-this-for)
- [What you get](#what-you-get)
- [Quick start](#quick-start)
- [Folder structure](#folder-structure)
- [The five specialist subagents](#the-five-specialist-subagents)
- [Skills (reusable workflows)](#skills-reusable-workflows)
- [Memory and documentation strategy](#memory-and-documentation-strategy)
- [Coding standards](#coding-standards)
- [Tech stack defaults](#tech-stack-defaults)
- [How it compares to alternatives](#how-it-compares-to-alternatives)
- [FAQ](#faq)
- [References](#references)
- [License](#license)

---

## What is this?

This is a **Claude Code starter template** — a GitHub template repository you clone once to give every new full-stack TypeScript project a complete AI development environment out of the box.

Instead of manually setting up `CLAUDE.md`, defining subagents, and writing workflow skills every time you start a project, you click *"Use this template"* and get:

- Five specialist AI subagents tuned for full-stack TypeScript work
- A `new-feature` skill that orchestrates them end-to-end
- Pre-configured permissions in `.claude/settings.json`
- Architecture, product, and ADR documentation scaffolding
- Coding standards Claude Code follows automatically

It is to Claude Code what `create-react-app` is to React: a sensible, opinionated default that gets you to the work faster.

## Who is this for?

- **Solo developers** building SaaS, internal tools, or side projects with Claude Code
- **Small teams (2–10 engineers)** who want a shared AI workflow across projects
- **Engineering leads** establishing AI development standards for their org
- **Consultants and agencies** spinning up new client projects on a repeatable foundation

Skip this if: you already have a heavily customized `.claude/` setup or your team uses an AI coding tool other than Claude Code.

## What you get

| Component | What it does |
|---|---|
| **5 specialist subagents** | Architect, Frontend, Backend, QA, Code Reviewer — each in `.claude/agents/` |
| **Auto-routing** | Claude Code matches your request to the right agent via descriptions |
| **Feature workflow skill** | `/new-feature` orchestrates all five agents in the right order |
| **Coding standards** | TypeScript-strict, Zod validation, layered architecture, no `any` |
| **ADR scaffolding** | `docs/decisions/` with template — never lose architectural context again |
| **Product context doc** | `docs/product.md` keeps the *why* in Claude's context every session |
| **Pre-allowed permissions** | Common safe commands (`pnpm`, `git status`, tests) skip the prompt |
| **Gitignore-ready** | Personal files (`CLAUDE.local.md`, `settings.local.json`) excluded by default |

## Quick start

### Option 1: Use the GitHub template (recommended)

1. Click [**Use this template**](https://github.com/rdhawladar/claude-code-fullstack-starter/generate) at the top of this repo.
2. Name your new project, choose visibility, and click *Create repository*.
3. Clone it locally:
   ```bash
   git clone https://github.com/<your-username>/<your-project>.git
   cd <your-project>
   ```
4. Open Claude Code in the project directory:
   ```bash
   claude
   ```
5. Start working — agents auto-load from `.claude/agents/`.

### Option 2: GitHub CLI

```bash
gh repo create my-new-project \
  --template rdhawladar/claude-code-fullstack-starter \
  --private \
  --clone
cd my-new-project
claude
```

### Option 3: Clone manually

```bash
git clone https://github.com/rdhawladar/claude-code-fullstack-starter.git my-project
cd my-project
rm -rf .git && git init
claude
```

### First steps inside Claude Code

```
> /new-feature add user authentication with email and password
```

Claude routes through architect → backend → frontend → QA → code reviewer automatically.

## Folder structure

```
your-project/
├── CLAUDE.md                       # Project rules + tech stack + standards (committed)
├── CLAUDE.local.md                 # Personal scratch (gitignored)
├── .gitignore                      # Excludes .local files, node_modules, env
├── .claude/
│   ├── settings.json               # Pre-allowed commands, MCP servers (committed)
│   └── agents/
│       ├── architect.md            # Tech decisions, ADRs (Opus)
│       ├── frontend-specialist.md  # React + TS (Sonnet)
│       ├── backend-specialist.md   # Node + Postgres + Zod (Sonnet)
│       ├── qa-engineer.md          # Tests + edge cases (Sonnet)
│       └── code-reviewer.md        # Pre-merge audit (Opus)
│   └── skills/
│       └── new-feature/SKILL.md    # End-to-end feature workflow
└── docs/
    ├── product.md                  # Product context (the *why*)
    ├── architecture.md             # System design + folder layout
    └── decisions/
        └── 0001-template.md        # ADR template
```

## The five specialist subagents

Each agent lives in `.claude/agents/<name>.md` with YAML frontmatter (name, description, tools, model) plus a markdown system prompt. Claude Code auto-routes tasks based on the `description` field, or you can invoke them explicitly with `@agent-name`.

| Agent | Model | When to use |
|---|---|---|
| **architect** | Opus | Choosing libraries, designing modules, writing ADRs, evaluating trade-offs |
| **frontend-specialist** | Sonnet | React components, hooks, styling, accessibility, browser testing |
| **backend-specialist** | Sonnet | API endpoints, DB schema, services, auth, background jobs |
| **qa-engineer** | Sonnet | Writing tests, edge cases, regression analysis, test strategy |
| **code-reviewer** | Opus | Pre-merge review for correctness, security, readability, standards |

Why Opus for architect and reviewer? Both are judgment-heavy roles where reasoning quality matters more than throughput. The implementation specialists use Sonnet — faster and cheaper without sacrificing capability for routine code work.

Customize any agent by editing its markdown file. Add new agents by dropping new `.md` files in `.claude/agents/`.

## Skills (reusable workflows)

Skills are saved playbooks Claude loads on demand. This template ships with one:

- **`new-feature`** — orchestrates architect → backend → frontend → QA → code reviewer for any full-stack feature

Add your own at `.claude/skills/<name>/SKILL.md` with frontmatter describing when it should trigger. Examples worth adding as your project grows:

- `deploy-staging` — pre-deploy checks, run migrations, push, verify
- `fix-bug` — reproduce → write failing test → fix → confirm green
- `add-migration` — schema change → migration file → update repo → regenerate types
- `release` — bump version, generate changelog, tag, publish

## Memory and documentation strategy

This template uses Claude Code's native memory system instead of patterns like "Memory Bank" that maintain six parallel markdown files. Here's where each kind of information lives:

| Information type | Location | Why |
|---|---|---|
| Build commands, code style, repo conventions | `CLAUDE.md` | Loaded every session |
| Product context (problem, users, success) | `docs/product.md` | Imported into `CLAUDE.md` |
| System design, folder layout, stack | `docs/architecture.md` | Imported into `CLAUDE.md` |
| Architectural decisions | `docs/decisions/NNNN-*.md` | ADR format — never forget *why* |
| Repeatable workflows | `.claude/skills/<name>/SKILL.md` | Load on demand |
| Bugs and remaining work | Issue tracker (GitHub, Linear, Jira) | Searchable, not noise in context |
| Personal scratch / local URLs | `CLAUDE.local.md` | Gitignored, stays on your machine |

`CLAUDE.md` imports `docs/product.md` and `docs/architecture.md` via the `@path/to/file.md` syntax — so the full context loads on every session without duplication.

## Coding standards

The included `CLAUDE.md` enforces:

- **TypeScript strict mode** — no `any`, no unjustified `as` casts
- **Readable over clever** — descriptive names, small functions, no premature abstraction
- **No dead code** — unused vars, exports, imports deleted immediately
- **Layered backend** — route handler → service → repository
- **Validation at boundaries** — Zod at every external edge (HTTP, queue, env)
- **Comments explain *why*, not *what*** — default is no comment
- **Errors are typed** — domain errors mapped to HTTP at the edge

Edit `CLAUDE.md` to adjust to your team's preferences. The standards apply across all five subagents.

## Tech stack defaults

These are the defaults the architect agent recommends. None are mandatory — change `docs/architecture.md` to lock in your team's choices.

| Layer | Default | Why |
|---|---|---|
| Language | TypeScript (strict) | End-to-end type safety |
| Package manager | pnpm | Fast, disk-efficient, strict resolution |
| Frontend | React + Vite (or Next.js) | Mature, hireable, good DX |
| Styling | Tailwind CSS | Co-located, no naming overhead |
| State | TanStack Query + Zustand | Server vs UI state, separated |
| Forms | React Hook Form + Zod | Performant + shared validation |
| Backend | Hono on Node.js | Lightweight, typed, fast |
| Database | Postgres | Boring, reliable, ubiquitous |
| ORM | Drizzle | TypeScript-native, close to SQL |
| Validation | Zod | Single schema for runtime + types |
| Auth | Lucia / Better Auth + cookies | Simple, no JWT footguns |
| Testing | Vitest + Playwright | Fast unit, real-browser E2E |

## How it compares to alternatives

| Approach | Setup time | Multi-agent | Standards | Best for |
|---|---|---|---|---|
| **This template** | 30 seconds | Yes (5 specialists) | Built in | Full-stack TS projects with Claude Code |
| Empty `CLAUDE.md` | 5 minutes | No | None | Throwaway scripts |
| Memory Bank pattern | 1 hour | No | Manual upkeep | Pre-Claude-Code era (Cline) |
| Custom from scratch | 4–8 hours | Depends | Whatever you write | One-off projects with unusual needs |
| Cursor / Copilot setup | N/A | No | Limited | Teams not using Claude Code |

## FAQ

### What is Claude Code?

[Claude Code](https://docs.claude.com/en/docs/claude-code) is Anthropic's official CLI agent for software development. It runs in your terminal, reads and edits files in your project, executes commands, and uses subagents to specialize work — all powered by Claude.

### What is a Claude Code subagent?

A subagent is a specialized AI persona defined in a markdown file at `.claude/agents/<name>.md`. It has its own system prompt, tool access, and (optionally) its own model. Claude Code routes tasks to the right subagent based on each agent's `description` field. See [Anthropic's subagent docs](https://docs.claude.com/en/docs/claude-code/sub-agents).

### Do I need all five subagents?

No. Delete any `.md` file in `.claude/agents/` to remove an agent. Add new ones by creating new files. The five included here are common roles for full-stack TypeScript work, not a rigid requirement.

### How do I use this template for a new project?

Click **Use this template** at the top of the repo, or run `gh repo create my-project --template rdhawladar/claude-code-fullstack-starter`. Then `cd` into the new project and run `claude`.

### What is the difference between a fork and a template?

A **fork** keeps a permanent link to the original repo (good for contributing back). A **template** creates an independent copy with no shared history (good for starting your own project). Use *template* for this repo.

### Can I use this without TypeScript?

Yes, but you'll need to edit `CLAUDE.md`, `docs/architecture.md`, and the agent files to remove TypeScript-specific guidance. The structure (5 agents, skills, ADRs) works for any stack.

### How is this different from Cursor or GitHub Copilot setups?

This is specifically for **Claude Code** — Anthropic's terminal-based agent CLI. Cursor and Copilot are IDE-integrated assistants with different configuration models. This template doesn't apply to them.

### Should I commit `.claude/settings.local.json`?

No. It's already in `.gitignore`. The `.local` variant is for personal overrides (extra permissions, machine-specific env vars) and should never be committed.

### Where do I track bugs and TODOs?

In your **issue tracker** (GitHub Issues, Linear, Jira) — not in `CLAUDE.md` or random markdown files. Issue trackers are searchable, assignable, and don't pollute Claude's context. `CLAUDE.md` is for persistent rules, not ephemeral work.

### What is an ADR?

An **Architecture Decision Record** captures the *why* behind a non-trivial technical choice (framework, pattern, library). The template at `docs/decisions/0001-template.md` shows the format. Write one whenever the architect agent makes a real call.

### Can I add my own subagents?

Yes. Create `.claude/agents/<name>.md` with YAML frontmatter (`name`, `description`, `tools`, `model`) and a markdown system prompt. Claude Code auto-loads it on next session.

### Does this work with monorepos?

Yes — pnpm workspaces are the default, and the layered folder structure in `docs/architecture.md` is monorepo-friendly. Add a workspace-level `pnpm-workspace.yaml` and per-package `CLAUDE.md` files if needed (project-level `CLAUDE.md` overrides parent ones).

## References

### Official documentation

- [Claude Code documentation](https://docs.claude.com/en/docs/claude-code) — official Anthropic docs
- [Claude Code subagents guide](https://docs.claude.com/en/docs/claude-code/sub-agents) — how subagents work
- [Claude Code memory and CLAUDE.md](https://docs.claude.com/en/docs/claude-code/memory) — memory hierarchy
- [Claude Code settings reference](https://docs.claude.com/en/docs/claude-code/settings) — `settings.json` schema
- [Claude Code best practices](https://www.anthropic.com/engineering/claude-code-best-practices) — Anthropic's engineering guide

### Related concepts

- [TypeScript strict mode](https://www.typescriptlang.org/tsconfig#strict)
- [Architecture Decision Records (Michael Nygard)](https://www.cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
- [Zod runtime validation](https://zod.dev/)
- [Drizzle ORM](https://orm.drizzle.team/)
- [TanStack Query](https://tanstack.com/query)
- [pnpm package manager](https://pnpm.io/)

## License

MIT — see [LICENSE](LICENSE). Use it freely for personal or commercial projects.

---

**Keywords:** Claude Code template, Claude Code starter, Claude Code subagents, AI development workflow, TypeScript full-stack starter, multi-agent coding, AI coding standards, Anthropic Claude CLI, Claude Code best practices, full-stack TypeScript template, AI pair programming, automated code review, architecture decision records, ADR template, React TypeScript starter, Node.js TypeScript starter.
