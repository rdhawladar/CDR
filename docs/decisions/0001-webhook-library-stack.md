# 0001. Webhook Delivery Library — Stack and Design

Date: 2026-05-04
Status: Accepted

## Context

We are building an embeddable TypeScript library that any Node.js application can install to reliably deliver webhooks to registered subscriber URLs. The public surface is small:

```ts
const webhooks = createWebhooks({ ... })
await webhooks.register('order.created', 'https://example.com/hook')
await webhooks.emit('order.created', { orderId: 123 })
```

Hard requirements:

1. Pending and in-flight deliveries must survive a process restart.
2. `emit()` must return fast, independent of subscriber latency.
3. Fan-out to multiple subscribers per event.
4. Ship with an example app and a README.

Constraints: 2-hour build budget, single-process embedding model, no external infrastructure assumed at install time. The library is consumed via `import`, not run as a separate service.

## Options Considered

### Persistence
- **SQLite via `better-sqlite3`** — zero-config, ACID, synchronous API (no event-loop juggling for tiny txns), runs anywhere Node runs, file-based durability. Cons: single-writer, single-process.
- **Postgres via `pg` + Drizzle** — multi-process safe, `LISTEN/NOTIFY` for push-based wakeup, `SELECT ... FOR UPDATE SKIP LOCKED` for safe multi-worker claiming. Cons: requires a running Postgres instance — incompatible with "embed in any Node app" without a heavy install story.
- **In-memory only** — fails requirement (1). Rejected.
- **Pluggable storage interface** — correct long-term answer, overkill for a 2-hour take-home. Defer.

### Job Dispatch
- **Pure polling worker** — simple, robust, but emit-to-dispatch latency floor equals poll interval. Looks lazy.
- **Pure event-driven (in-process emitter)** — low latency, but loses retries and crash recovery on its own.
- **Hybrid: in-process wakeup + slow polling fallback** — emit() inserts, then nudges the worker via `setImmediate`; a 5s timer sweeps for retries due and orphaned leases. Best of both.
- **External queue (BullMQ + Redis, SQS)** — violates the embed constraint and the time budget.

### HTTP Client
- **Native `fetch` (Node 18+)** — no dependency. Sufficient.
- **`undici` directly** — marginal perf gain, extra dep. Not worth it.
- **`axios`** — legacy, larger surface. Skip.

### Signing
- **HMAC-SHA256** over `timestamp + body`, sent as `X-Webhook-Signature` and `X-Webhook-Timestamp`. Industry standard (Stripe, GitHub).
- **Asymmetric (Ed25519)** — overkill for v1, no current consumer requirement.

### Language / Tooling
- TypeScript strict, no `any`.
- pnpm workspaces (root + `packages/webhooks` + `examples/order-app`).
- `tsup` for dual ESM/CJS build with `.d.ts`.
- Vitest for unit tests; one integration test that boots the worker, fires `emit`, and asserts the subscriber receives a signed POST.

## Decision

We will ship the library with this stack:

| Concern | Choice |
|---|---|
| Language | TypeScript strict |
| Persistence | SQLite via `better-sqlite3` |
| Dispatch | Hybrid worker: in-process wakeup + 5s polling fallback |
| HTTP | native `fetch` |
| Signing | HMAC-SHA256 with timestamp |
| Build | `tsup` (ESM + CJS + types) |
| Tests | Vitest |
| Pkg manager | pnpm workspaces |

### Delivery State Machine

Each `delivery` row (one row per event-subscriber pair, created at `emit()` time) moves through:

```
pending  -- worker claims with lease -->  claimed
claimed  -- before fetch() is awaited -->  dispatching
dispatching -- 2xx response -->  delivered
dispatching -- non-2xx / error / timeout -->  pending (next_attempt_at = now + backoff)
                                              after N attempts -->  dead
```

Key invariants:

- The transition `claimed -> dispatching` is a DB write that happens **before** the HTTP request is awaited. This is the row that says "we may have already sent this."
- The transition `dispatching -> delivered` happens **after** the response is received, in a single transaction.
- Every `claimed` and `dispatching` row carries a `lease_expires_at`. On boot, and on every poll tick, rows whose lease has expired are reset to `pending`. A process that crashed mid-`fetch` will therefore have its delivery retried.
- This design is at-least-once: a `dispatching` row whose response was received-but-not-persisted (process killed in the millisecond between ack and DB write) **will** be redelivered. Subscribers must be idempotent. We surface this by sending a stable `X-Webhook-Delivery-Id` header (the row's UUID) for dedup on the receiver side.

### emit() Hot Path

```
emit(event, payload):
  begin tx
    insert event row
    for each active subscriber of `event`:
      insert delivery row (status=pending, next_attempt_at=now)
  commit
  worker.wakeup()    // setImmediate; does not await
  return
```

`emit()` does N+1 small SQLite inserts in one transaction and returns. Subscriber HTTP latency is never on this path.

### Restart Recovery

On `createWebhooks()` boot:

1. `UPDATE deliveries SET status='pending', lease_expires_at=NULL WHERE status IN ('claimed','dispatching') AND lease_expires_at < now()`.
2. Start the worker. The worker pulls due `pending` rows, claims them (status, `lease_expires_at = now + 60s`), writes `dispatching`, then awaits `fetch`.

### Repository Layout

```
/
├── packages/webhooks/          # the library, publishable as @cdr/webhooks
│   ├── src/
│   │   ├── index.ts            # createWebhooks(), public types
│   │   ├── store.ts            # SQLite schema + queries
│   │   ├── worker.ts           # claim, dispatch, retry, lease sweep
│   │   ├── signing.ts          # HMAC sign + verify helper (exported)
│   │   ├── backoff.ts
│   │   └── types.ts
│   ├── test/
│   │   ├── emit.test.ts
│   │   ├── retry.test.ts
│   │   └── recovery.test.ts
│   ├── README.md               # the npm-visible README
│   ├── package.json            # exports, types, files
│   └── tsup.config.ts
├── examples/order-app/         # consumes the lib via workspace:*
│   ├── src/server.ts           # registers + emits
│   ├── src/subscriber.ts       # tiny receiver that verifies signature
│   └── package.json
├── pnpm-workspace.yaml
├── docs/decisions/0001-webhook-library-stack.md
└── README.md                   # repo root: orientation + links
```

## Consequences

### Positive
- Zero infrastructure to run the example or the tests. `pnpm i && pnpm test` works on a fresh clone.
- Type-safe end to end; consumers get full IntelliSense on event names if they pass a generic map.
- Clear delivery state machine with explicit at-least-once semantics — the kind of thing an interviewer wants to hear articulated.
- The `dispatching` state and lease sweep correctly handle the three failure modes (worker crash before send, crash mid-send, crash after send before ack-write).

### Negative
- Single-process only. A second Node process pointed at the same SQLite file will at best contend on the writer lock and at worst double-dispatch if both claim the same row before the other's transaction commits. This is acceptable for the scope but **must be flagged in the README**.
- `better-sqlite3` is a native module — slower install, needs a build toolchain on exotic platforms.
- At-least-once means the burden of idempotency is pushed to the subscriber. We mitigate by sending `X-Webhook-Delivery-Id`.
- Polling fallback wakes the event loop every 5s even when idle. Negligible, but not zero.

### Follow-ups Required
- README must document: at-least-once contract, signature scheme, idempotency expectation, single-process limitation.
- Pluggable `Store` interface (SQLite today, Postgres tomorrow) is the natural v2 — this is the "tradeoff to revisit."
- Per-subscription concurrency limit and circuit breaker for slow/dead subscribers (a hot subscriber today can starve others on the worker).
- Consider per-key ordering guarantees (FIFO per partition key) once a real consumer asks for it — not free, costs head-of-line blocking.

## Tradeoff to Revisit (the interesting one)

Not "polling vs Redis." The real open question is **delivery ordering**. Today fan-out is unordered: two `order.updated` events for the same `orderId` may arrive at the subscriber out of order if the first attempt fails and retries while the second succeeds on the first try. If consumers need per-key FIFO, we need a `partition_key` column, a per-partition serial dispatcher, and we accept head-of-line blocking. That is a product decision, not an infra one, and it should be made before v1 ships to a real customer.
