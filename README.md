# @cdr/webhooks

Embeddable, durable webhook delivery for Node.js. A single `import`, a SQLite file, and a hybrid in-process worker — no Redis, no broker, no separate service.

```ts
import { createWebhooks } from '@cdr/webhooks';

const webhooks = createWebhooks({ signingSecret: process.env.WEBHOOK_SECRET! });

await webhooks.register('order.created', 'https://example.com/hook');
await webhooks.emit('order.created', { orderId: 123 });
```

`emit()` is bounded by a local SQLite transaction — it does **not** await the subscriber's HTTP request. A worker drains the queue asynchronously, retries with exponential backoff, and resumes any work in flight on restart.

---

## Quick start

```bash
pnpm install
pnpm test         # 6 tests; ~600 ms
pnpm typecheck
```

### Run the example app

Two terminals.

```bash
# terminal 1 — receiver (will fail twice then succeed, to demo retries)
FAIL_UNTIL=2 pnpm example:receiver

# terminal 2 — emit a single order.created event
pnpm example:emitter
```

You should see, in the receiver log:

```
[receiver] forcing failure 1/2 for order.created 9be933ad-...
[receiver] forcing failure 2/2 for order.created 9be933ad-...
[receiver] OK order.created delivery=9be933ad-... body={"orderId":24221,...}
```

All three attempts carry the same `x-webhook-delivery-id` — that's the row UUID, used by receivers to dedupe.

---

## API

```ts
const webhooks = createWebhooks({
  signingSecret: 'shared-secret-with-receivers',  // required
  dbPath: './webhooks.db',                         // default
  maxAttempts: 8,                                  // default
  baseRetryDelayMs: 1_000,                         // default
  maxRetryDelayMs: 60_000,                         // default
  requestTimeoutMs: 10_000,                        // default
  pollIntervalMs: 5_000,                           // default
  autoStart: true,                                 // default
});

await webhooks.register(eventName, url);          // → { id }
await webhooks.emit(eventName, payload);           // → { deliveryIds }
await webhooks.close();
```

Outgoing requests carry these headers:

| Header | Purpose |
|---|---|
| `x-webhook-event` | event name |
| `x-webhook-delivery-id` | row UUID — stable across retries; **use for receiver dedup** |
| `x-webhook-timestamp` | unix ms when this attempt was sent |
| `x-webhook-signature` | `sha256=<hex>` HMAC over `${timestamp}.${body}` |

`verify(secret, ts, body, signature)` is exported for receivers; the example app uses it.

---

## How delivery works

### State machine

Each `(event, subscriber)` pair becomes one row in `deliveries`. The row moves through:

```
pending  --(worker claims)-->  claimed
claimed  --(write before await fetch)-->  dispatching
dispatching  --(2xx response)-->  delivered
dispatching  --(non-2xx / error / timeout)-->  pending  (next_attempt_at = now + backoff)
                                              after maxAttempts -->  dead
```

The transition `claimed → dispatching` is committed to disk **before** the HTTP request is awaited. That's the row that says *"we may already have sent this."* On boot, any row left in `claimed` or `dispatching` is reset to `pending` and retried — that's how a `kill -9` mid-fetch recovers.

### Dispatch (hybrid)

`emit()` does N inserts in one transaction (one per registered subscriber), commits, then schedules a worker tick via `setImmediate`. A 5 s polling timer also fires to handle retries that come due and to sweep recovered rows. Pure polling is too lazy; pure event-driven loses retries on its own.

### Backoff

`baseRetryDelayMs * 2^(attempt - 1)` capped at `maxRetryDelayMs`, with equal-jitter — half deterministic, half random — to spread thundering herds without collapsing the lower bound.

---

## Delivery guarantees

| Guarantee | Holds because |
|---|---|
| **At-least-once** | Every state transition is committed before the next side effect. A dispatch crash redelivers. |
| **Durable across restarts** | All state lives in SQLite (WAL mode, `synchronous=NORMAL`). On boot, in-flight rows are reset to pending. |
| **Caller-decoupled** | `emit()` only awaits a local DB transaction. In the smoke test it returns in **~1 ms** even when subscribers are failing. |
| **Idempotent registration** | `register(event, url)` is `INSERT ... ON CONFLICT DO NOTHING`; calling it on every boot is fine. |

We do **not** offer:

- **Exactly-once** — we send `x-webhook-delivery-id` so receivers can dedupe. The receiver in `examples/order-app/receiver.ts` shows the pattern.
- **Ordering across deliveries** — see "tradeoff to revisit" below.
- **Multi-process workers** — see "limitations" below.

---

## Limitations (be honest about them)

- **Single Node process per database file.** Two processes pointing at the same SQLite file will at best contend on the writer lock and at worst double-dispatch a row. If you need to scale out workers, run them against Postgres + `SELECT FOR UPDATE SKIP LOCKED` (or move to a real broker). The library is designed to be embedded inside one app server, not run as a fleet.
- **Native module.** `better-sqlite3` builds from source on `pnpm install` (pnpm 9+ requires `pnpm.onlyBuiltDependencies` allow-listing — already configured in `package.json`). First install takes ~15 s and needs a working C++ toolchain.
- **Polling fallback wakes the event loop every 5 s** even when idle. Negligible CPU but not zero. Tunable via `pollIntervalMs`.

---

## The one tradeoff I'd revisit with more time

**Per-key FIFO ordering.** Today fan-out is unordered: two `order.updated` events for the same `orderId` may arrive at the subscriber out of order if attempt 1 fails and retries while attempt 2 succeeds on the first try. For many use cases that's fine; for state-replication use cases it's a footgun.

Adding ordering would mean a `partition_key` column, per-partition serial dispatch, and accepting head-of-line blocking — a stuck `orderId=42` blocks every other `orderId=42` event behind it. **It's a product decision, not an infra one,** and it should be made before shipping to any real consumer.

I picked this over the more obvious "polling vs Redis/BullMQ" tradeoff because polling-vs-broker is table stakes, whereas ordering is the question that actually bites you when a real customer hooks this up to a state machine.

---

## Project layout

```
src/
  index.ts        public createWebhooks(), exports
  store.ts        SQLite schema + queries
  worker.ts       hybrid dispatcher, backoff, recovery
  signing.ts      HMAC sign/verify
  backoff.ts      jittered exponential backoff
  types.ts
test/
  webhooks.test.ts   6 tests: emit, signing, fan-out, retry, dead-letter, recovery
examples/order-app/
  receiver.ts     Express server that verifies HMAC + dedupes by delivery id
  emitter.ts      one-shot emit demo
docs/decisions/
  0001-webhook-library-stack.md   ADR — full design rationale
PROMPTS.md        AI-assisted process notes for the follow-up interview
```

---

## License

MIT — see `LICENSE`.
