# Product Context

The *why* behind this project. Architecture lives in `architecture.md`; this file answers what we're building and for whom.

## Problem

Node.js applications routinely need to notify external systems when business events occur (e.g. `order.created`, `user.signed_up`). Rolling delivery yourself is deceptively hard: a subscriber that's slow or down must not block the caller, and a process crash must not silently drop pending or in-flight webhooks. Most teams either reach for a heavyweight queue (Redis + BullMQ + an ops surface) or build a fragile in-memory loop that loses messages on restart.

We're building an embeddable TypeScript library that gives any Node.js app reliable webhook delivery with **zero external infrastructure** — durable, async, with retries — through a 3-line API.

## Users

- **Primary:** TypeScript/Node.js backend developers building small-to-medium apps who want reliable webhook delivery without standing up a queue.
- **Secondary:** Reviewers evaluating this take-home assignment for engineering judgment, code quality, and clarity of tradeoffs.
- **Not for:** High-throughput systems (>10k events/min) — those should use a real broker (Kafka/SQS/BullMQ).

## What Success Looks Like

- A developer can integrate the library in under 5 minutes following the README.
- `emit()` returns in <10 ms regardless of subscriber latency.
- A `kill -9` on the host process loses zero acknowledged events on restart.
- The example app demonstrates registration, emission, retry on subscriber failure, and restart recovery.
- README clearly states delivery guarantees (at-least-once, durable, decoupled) and one honest tradeoff.

## Core Use Cases

1. **Register a subscriber** — `webhooks.register('order.created', 'https://...')` persists the URL against an event type.
2. **Emit an event** — `webhooks.emit('order.created', payload)` returns immediately; the library fans out to all registered subscribers asynchronously with retries.
3. **Recover from crashes** — on restart, the library picks up any pending or in-flight deliveries and resumes work.

## Non-Goals

- No subscriber management UI / admin dashboard.
- No exactly-once delivery — at-least-once with HMAC + idempotency hint is the contract.
- No multi-tenant routing or per-subscriber rate limits in v1.
- No distributed worker pool — single-process worker only (a follow-up tradeoff in the README).
- No web UI for inspecting dead-letter rows in v1.

## Constraints

- **Deadline:** 2-hour total build time (take-home assignment).
- **Deliverables:** working library + example app + README + GitHub URL.
- **Stack:** TypeScript strict mode, pnpm, project conventions in `CLAUDE.md`.
- **Process:** document prompts and decisions for the follow-up interview.
- **Infra budget:** zero — must run with `pnpm install && pnpm start` and no external services.

## Open Questions

- Should the library expose a way to inspect dead-lettered events programmatically? (Probably yes — minimal API, defer admin UI.)
- Do we ship the SQLite path as configurable, or hard-code `./webhooks.db`? (Configurable wins for ~5 lines of code.)
- HMAC signing on by default, or opt-in via config? (Default on, with a shared secret in config.)
