# AI-assisted Process — Prompts and Decisions

This take-home was built collaboratively with Claude Code (Opus 4.7). I've kept this log so the interview can dig into *how* the AI was used, not just the artifact.

The actual ADR is at `docs/decisions/0001-webhook-library-stack.md`. The validated stack lives in memory at `~/.claude/projects/-Users-md-riadulislam-Developer-CDR/memory/`.

---

## 1. Framing — before any code was written

**My instruction:** "we will solve the following problem — Build a TypeScript library that any Node.js application can use to reliably deliver webhook messages…"

**What I wanted from the AI:** to *not* start coding. I wanted it to restate the problem, surface implicit requirements, and commit to a stack on paper first.

**What the AI produced:** a restatement that named the implicit requirements I cared about — **at-least-once delivery semantics**, **bounded `emit()` latency**, **fan-out per event** — and proposed SQLite + a polling worker. It also flagged that "polling vs BullMQ" was the obvious tradeoff to revisit.

**Why this mattered:** the model wanted to start building. Forcing it to plan first caught a sloppy state machine before any code existed.

---

## 2. Architecture validation via the architect sub-agent

**My instruction:** "before proceeding with the table — verify our architecture and stack with the architect agent. update the product.md file, our memory etc so that any session can resume our task."

**Why I did this:** I have a project convention (in `CLAUDE.md`) that says non-trivial choices go through the architect agent and get an ADR. I wanted independent pushback on my proposal, not just a yes-and from the implementing model.

**What the architect pushed back on (this is the most useful part of the whole exercise):**

1. **Pure polling is lazy in an interview.** Use a hybrid: `emit()` writes rows then nudges the worker via `setImmediate`; a slow polling tick (5 s) is a *fallback* for retries due and orphaned leases.
2. **Three states wasn't enough.** I had `pending → in_flight → delivered`. The architect insisted on **four** — `pending → claimed → dispatching → delivered/dead` — because the row that says *"we wrote a state to disk and may have already sent this"* has to exist independently of *"we have a row claimed and are about to send."* The killer case is "ack received from subscriber, process killed before we wrote `delivered`." At-least-once means it gets redelivered; subscribers must dedupe via `x-webhook-delivery-id`.
3. **The tradeoff to revisit should be sharper than "BullMQ vs polling."** That's table stakes. The architect proposed **per-key FIFO ordering** instead — a product question with real teeth (head-of-line blocking trade). I adopted that.
4. **README must explicitly call out the single-process limit.** Hiding it would be dishonest.

The full ADR (with the state machine, emit() hot path pseudocode, and folder layout) is in `docs/decisions/0001-webhook-library-stack.md`.

---

## 3. Time-budget reality check

After validation, the architect's full design (pnpm workspaces + `tsup` for dual ESM/CJS + lease sweep + 3 tests) was a ~3-hour build, not 90 minutes. **My instruction:** "we have only 1 hr 30 mins, is this architecture can be achieved within this time?"

**The model's honest answer (which I appreciated):** no, ~155 minutes for the full design. It proposed four cuts I accepted:

1. Drop pnpm workspaces → single package with `examples/` subfolder.
2. Drop `tsup` → plain `tsc`. (It's a take-home, not an npm publish.)
3. Drop per-row leases → simpler boot-time reset of all `claimed`/`dispatching` rows. We're single-process; leases earn their complexity only with a worker fleet.
4. Trim 3 tests → 2 critical tests (retry + recovery). `emit()` is implicitly covered by both.

I added a 6th test as I built (dead-letter after maxAttempts) because it was nearly free once retry worked.

---

## 4. Implementation order (parallelised aggressively)

1. Scaffolded `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts` in one batch.
2. Started `pnpm install` in the background; while it ran, wrote the leaf source files (`types.ts`, `signing.ts`, `backoff.ts`, then `store.ts`).
3. Wrote `worker.ts` and `index.ts`.
4. Ran `pnpm typecheck` (clean).
5. Wrote `test/webhooks.test.ts` (6 tests covering emit, signing, fan-out, retry, dead-letter, recovery + mid-flight crash recovery).
6. Hit a snag: pnpm 9 blocks `better-sqlite3`'s install hook by default. Added `pnpm.onlyBuiltDependencies` to `package.json` and reinstalled — passed.
7. Built `examples/order-app/{receiver,emitter}.ts`.
8. Smoke test — found a bug in my receiver's force-failure logic: I was conflating the dedupe set with the failure counter. Separated them.
9. README + this file + commit.

---

## 5. What I would tell a reviewer is the most interesting part of the code

Look at `src/worker.ts:dispatch()`:

```ts
this.opts.store.markDispatching(delivery.id);   // committed to disk
//                                              // <-- crash here = redeliver
const res = await this.opts.fetchImpl(...);
if (res.ok) this.opts.store.markDelivered(...);
//                                              // <-- crash here = also redeliver
```

That tiny window between `markDispatching` and the network `await` is what determines the delivery contract. Writing `dispatching` before the request means we will **never lose a delivery** to a process crash; it also means we will sometimes deliver twice. Both halves of the at-least-once contract are visible in 3 lines.

---

## 6. Files to read (in order)

1. `docs/decisions/0001-webhook-library-stack.md` — design rationale
2. `src/store.ts` — schema + queries (read first; everything else is layered on top)
3. `src/worker.ts` — the dispatch loop and recovery
4. `src/index.ts` — the 30-line public API
5. `test/webhooks.test.ts` — the proofs of the README's guarantees
