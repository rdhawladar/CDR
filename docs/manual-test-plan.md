# Manual Test Plan — `@cdr/webhooks`

**Audience:** a QA engineer with general Node.js familiarity who has never seen this repo before. By the end you will have run **every guarantee the README claims** by hand and verified the output yourself.

Estimated time: **20 minutes** for the full plan, or **3 minutes** for "just sanity check it" (Sections 1–3).

---

## 0. What you need before you start

| Tool | How to check | If missing |
|---|---|---|
| Node.js 18 or newer | `node -v` | Install via [nvm](https://github.com/nvm-sh/nvm) |
| pnpm 9 or newer | `pnpm -v` | `corepack enable && corepack prepare pnpm@latest --activate` |
| `sqlite3` CLI (optional but very useful) | `sqlite3 -version` | macOS: ships with the OS. Linux: `apt install sqlite3` |
| C++ toolchain (Xcode Command Line Tools on macOS, `build-essential` on Linux) | `cc -v` | macOS: `xcode-select --install`. Required by `better-sqlite3`'s native build. |

> **What is `pnpm`?** A package manager — same role as `npm` or `yarn`. Used here because it builds an ergonomic `node_modules/` and runs install scripts more strictly than `npm`.
>
> **What is `tsx`?** A runner that executes `.ts` files directly without a separate compile step. So `pnpm example:receiver` is conceptually `tsx examples/order-app/receiver.ts`.

---

## 1. Get the code and install

From any working directory:

```bash
git clone https://github.com/rdhawladar/CDR.git
cd CDR
pnpm install
```

**Expected:** the command prints progress for ~15 s, ends with `Done in …s`, and you see lines like:

```
.../node_modules/better-sqlite3 install: ...gyp info ok
.../node_modules/better-sqlite3 install: Done
```

> **Why the long install?** `better-sqlite3` is a *native* module — it compiles C++ to a `.node` binary on your machine. After the first install it is cached.

**Pass criteria:** `pnpm install` exits 0 with no `ERR_` lines and no `gyp ERR!` lines.

---

## 2. Sanity check — automated unit tests

```bash
pnpm test
```

**Expected output (last lines):**
```
 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  …
   Duration  ~600ms
```

**Pass criteria:** `Tests  6 passed (6)`.

What each of the 6 tests proves:

| # | Test | Guarantee verified |
|---|---|---|
| 1 | `emit() returns immediately and delivers asynchronously with a signed body` | `emit()` is bounded by a local DB write (asserts < 50 ms). HMAC signature on the body. |
| 2 | `fans out to multiple subscribers` | Two URLs → two HTTP POSTs |
| 3 | `retries a failing subscriber until it succeeds` | Server returns 500 twice then 200 → 3 deliveries with the **same delivery-id** |
| 4 | `marks deliveries dead after maxAttempts` | Server always 500 → row ends with `status='dead'` |
| 5 | `recovers pending deliveries across a process restart` | Boot 1: emit with worker disabled. Boot 2: worker auto-runs → delivery completes |
| 6 | `redelivers in-flight rows after a simulated mid-flight crash` | Manually flip a row to `dispatching` → reboot → row is reset to pending and delivered |

---

## 3. Type-check

```bash
pnpm typecheck
```

**Expected:** silent, exits 0. No output is good output (it ran `tsc --noEmit` and found no type errors).

---

## 4. Manual end-to-end — the happy path

You will need **two terminal windows**, both in the project root (`cd CDR`).

### 4.1 Start the receiver

In **terminal A**:

```bash
pnpm example:receiver
```

**Expected output:**
```
[receiver] listening on http://127.0.0.1:4001/hook
[receiver] secret=example-secret failUntil=0
```

Leave terminal A running. The receiver is an Express server that:
- verifies the HMAC signature on every request,
- dedupes by `x-webhook-delivery-id`,
- responds `200 ok` (because we did not set `FAIL_UNTIL`).

### 4.2 Emit an event

In **terminal B**:

```bash
pnpm example:emitter
```

**Expected output in terminal B:**
```
[emitter] emit() returned in 1ms with 1 delivery(s) queued
[emitter] orderId=24221 deliveryIds=9be933ad-cc50-…
[emitter] draining for 6000ms then closing...
[emitter] closed cleanly
```

**Expected output in terminal A:**
```
[receiver] OK order.created delivery=9be933ad-cc50-… body={"orderId":24221,"placedAt":"…"}
```

**Pass criteria:**
- Terminal B's `emit() returned in Xms` shows a value below ~50 ms.
- The delivery-id printed by terminal B matches the one terminal A logs.
- The body in terminal A's log contains the same `orderId` printed by terminal B.

> **What this proves:** caller-decoupled emission (1 ms is way faster than any network round trip) and HMAC signing (if signing were broken the receiver would log `BAD SIGNATURE`).

---

## 5. Manual end-to-end — retries (at-least-once)

This is the most important manual test. It proves that a temporarily-failing subscriber does not lose the message and does not block the caller.

Stop the receiver in terminal A (`Ctrl-C`).

**Terminal A** — start the receiver in "fail twice then succeed" mode:

```bash
FAIL_UNTIL=2 pnpm example:receiver
```

**Expected:**
```
[receiver] listening on http://127.0.0.1:4001/hook
[receiver] secret=example-secret failUntil=2
```

**Terminal B** — emit:

```bash
pnpm example:emitter
```

**Expected output in terminal A** (over the next ~3 s):
```
[receiver] forcing failure 1/2 for order.created 9be933ad-…
[receiver] forcing failure 2/2 for order.created 9be933ad-…
[receiver] OK order.created delivery=9be933ad-… body={"orderId":…}
```

**Pass criteria:**
- Three log lines in terminal A.
- All three carry the **same** delivery-id (proves retries reuse the same row UUID — that is what makes receiver-side dedup possible).
- Terminal B still showed `emit() returned in Xms` with a value under ~50 ms — the caller never saw the failures.

---

## 6. Manual end-to-end — durability (the restart-recovery claim)

This proves the README's "pending webhooks survive a process restart" claim with a real process crash, not a unit-test simulation.

### 6.1 Clean state

In any terminal, from project root:

```bash
find . -maxdepth 1 -name 'webhooks.db*' -delete
```

> Removes the SQLite database file (and its WAL/SHM siblings). Safe — the example writes only to `./webhooks.db`.

### 6.2 Emit while no receiver is up

Make sure terminal A has **no receiver running** (Ctrl-C if needed).

**Terminal B:**

```bash
pnpm example:emitter
```

**Expected (terminal B):**
```
[emitter] emit() returned in 1ms with 1 delivery(s) queued
[emitter] orderId=… deliveryIds=…
[emitter] draining for 6000ms then closing...
[emitter] closed cleanly
```

The worker tried to dispatch, hit `ECONNREFUSED`, and scheduled retries. After 6 s the emitter exits cleanly with the delivery row still in `pending` status with several attempts already burned.

### 6.3 Inspect the database (optional but illuminating)

```bash
sqlite3 webhooks.db 'SELECT id, status, attempts, last_error, datetime(next_attempt_at/1000, "unixepoch") AS next FROM deliveries;'
```

**Expected output (something like):**
```
9be933ad-…|pending|5|fetch failed|2026-05-04 04:42:33
```

`status=pending`, `attempts > 0`, `last_error` mentions a connection error. **This is the row whose redelivery we are about to verify.**

### 6.4 Start the receiver

**Terminal A:**

```bash
pnpm example:receiver
```

### 6.5 Trigger a fresh boot of the worker

The worker only runs while the emitter process is alive. To prove cross-process recovery, run the emitter again — its `createWebhooks()` boot will recover the old `pending` row **in addition to** emitting a new one.

**Terminal B:**

```bash
pnpm example:emitter
```

**Expected output in terminal A** (within ~6 s):

```
[receiver] OK order.created delivery=<old delivery id from 6.3> body={"orderId":<old orderId>,…}
[receiver] OK order.created delivery=<new delivery id> body={"orderId":<new orderId>,…}
```

**Pass criteria:**
- **Two** OK lines in terminal A, in either order.
- One of them carries the same delivery-id you saw in step 6.3. That row was inserted by a process that has since exited; the fact that it was delivered is the durability claim.

---

## 7. Manual end-to-end — mid-flight crash recovery (advanced)

This proves the harder version of the durability claim: rows whose worker died **after `markDispatching` was written but before `markDelivered` could be persisted** are recovered.

### 7.1 Clean state

```bash
find . -maxdepth 1 -name 'webhooks.db*' -delete
```

### 7.2 Create a "stuck" row

**Terminal A:** start the receiver.
```bash
pnpm example:receiver
```

**Terminal B:** emit and let it succeed.
```bash
pnpm example:emitter
```
You should see one OK line in terminal A.

**Terminal B:** simulate "process killed mid-fetch" by manually flipping the delivery row back to `dispatching`:
```bash
sqlite3 webhooks.db "UPDATE deliveries SET status='dispatching', attempts=1 WHERE 1=1;"
sqlite3 webhooks.db 'SELECT id, status, attempts FROM deliveries;'
```

**Expected:** the row's status is now `dispatching`. As far as a fresh boot is concerned, this row was being sent when the previous process died.

### 7.3 Trigger boot recovery

**Terminal B:**
```bash
pnpm example:emitter
```

**Expected output in terminal A:**

```
[receiver] duplicate delivery <old-id> ignored (at-least-once)
[receiver] OK order.created delivery=<new-id> body={"orderId":<new-orderId>,…}
```

**Pass criteria:**
- The **old** delivery-id reappears in terminal A. That is `recoverInflight()` resetting the row to `pending` on boot and the worker redelivering it.
- The receiver logs `duplicate delivery … ignored` — that is the at-least-once contract working as designed: the receiver dedupes via `x-webhook-delivery-id`.

> **Why this matters:** the at-least-once contract says "we may deliver twice." This step proves the duplicate is *visible* to the receiver, not silent — the receiver controls the idempotency.

---

## 8. Manual end-to-end — dead-letter (subscriber that never recovers)

Stop the receiver in terminal A.

**Terminal A** — start the receiver in "always fail" mode:

```bash
FAIL_UNTIL=99 pnpm example:receiver
```

(With `maxAttempts=8` default and `FAIL_UNTIL=99`, the receiver will reject every attempt.)

**Terminal B** — emit with a longer drain so all 8 attempts fit:

```bash
DRAIN_MS=20000 pnpm example:emitter
```

While the emitter waits, terminal A will show:
```
[receiver] forcing failure 1/99 for order.created …
[receiver] forcing failure 2/99 for order.created …
…
[receiver] forcing failure 8/99 for order.created …
```

After the emitter exits, inspect the row:

```bash
sqlite3 webhooks.db 'SELECT status, attempts, substr(last_error,1,40) AS err FROM deliveries;'
```

**Expected:**
```
dead|8|HTTP 503: temporarily failing
```

**Pass criteria:**
- `status=dead`
- `attempts=8` (the configured `maxAttempts`)
- `last_error` mentions HTTP 503

> **Why dead-letter matters:** without a cap, a permanently-broken subscriber would retry forever and waste resources. Hitting `dead` lets an operator (or a future admin endpoint) inspect what failed.

---

## 9. Manual end-to-end — HMAC verification (security)

This proves the receiver rejects forged requests.

Stop the receiver. Clean state.

```bash
find . -maxdepth 1 -name 'webhooks.db*' -delete
```

**Terminal A:**
```bash
pnpm example:receiver        # uses default secret 'example-secret'
```

**Terminal B** — emit with the *wrong* secret on the sender side:
```bash
WEBHOOK_SECRET=this-is-wrong pnpm example:emitter
```

**Expected output in terminal A** (the receiver is using `example-secret` and will reject signatures computed with `this-is-wrong`):
```
[receiver] BAD SIGNATURE for delivery <id>
[receiver] BAD SIGNATURE for delivery <id>
…
```

**Pass criteria:**
- Terminal A logs `BAD SIGNATURE`, never `OK`.
- Terminal B's emit returned fast as before — security failures don't block the caller, they look identical to "subscriber said 401."

---

## 10. Inspect the database (reference)

The state of the world lives in `./webhooks.db`. Useful queries:

```bash
# the schema
sqlite3 webhooks.db '.schema'

# every registered subscriber
sqlite3 webhooks.db 'SELECT * FROM subscribers;'

# every delivery, with human-readable next-attempt time
sqlite3 webhooks.db '
  SELECT id, status, attempts,
         datetime(next_attempt_at/1000, "unixepoch") AS next_attempt,
         substr(last_error, 1, 60) AS err
  FROM deliveries
  ORDER BY created_at DESC;'

# how many deliveries are dead?
sqlite3 webhooks.db 'SELECT status, COUNT(*) FROM deliveries GROUP BY status;'
```

---

## 11. Cleanup between runs

```bash
# remove the local DB so the next emit starts clean
find . -maxdepth 1 -name 'webhooks.db*' -delete

# kill any leftover example processes
pkill -9 -f 'examples/order-app' 2>/dev/null || true
```

> **Why this matters:** the example uses port 4001 by default. If a previous receiver is still running you will see `EADDRINUSE` on the next start.

---

## 12. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Could not locate the bindings file` on `pnpm test` | pnpm 9 blocks native installs by default; `better-sqlite3` was not built | Already configured in `package.json` (`pnpm.onlyBuiltDependencies`). If you still hit it: `pnpm rebuild better-sqlite3` |
| `EADDRINUSE: address already in use 4001` | A previous receiver is still running | `pkill -9 -f 'examples/order-app'` |
| `pnpm install` fails with `gyp ERR!` | Missing C++ toolchain | macOS: `xcode-select --install`. Linux: `apt install build-essential python3` |
| Tests hang on a single test | An old `FAIL_UNTIL=…` env var is set in your shell | `unset FAIL_UNTIL` and re-run |
| Emitter says `closed cleanly` but no OK in receiver | Emitter exited before the retry's `next_attempt_at`. Default backoff caps at 60 s | Use `DRAIN_MS=15000 pnpm example:emitter` to wait longer, or override `baseRetryDelayMs` in code |
| `sqlite3` CLI says `database is locked` | The example app is still running with its WAL open | Stop the emitter/receiver before querying with the CLI |

---

## 13. What "all green" looks like

If you completed sections 1–9 and everything matched the **Pass criteria**, you have personally verified, by observation:

- **Caller decoupling** (sections 4 and 5: `emit()` < 50 ms even when subscribers are slow or failing)
- **At-least-once delivery** (section 5: 3 attempts, same delivery-id)
- **Durability across process restarts** (section 6: row created by a dead process gets delivered)
- **Mid-flight crash recovery** (section 7: a row left in `dispatching` is reset and redelivered)
- **Dead-letter behavior** (section 8: a permanently-failing row goes to `status=dead` after `maxAttempts`)
- **HMAC signing and verification** (section 9: receiver rejects requests signed with the wrong secret)

That set of six is the entire delivery contract from the README.
