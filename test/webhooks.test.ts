import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createWebhooks, verify, type Webhooks } from '../src/index.js';

type Received = { headers: Record<string, string>; body: unknown; raw: string };

let tmpDir: string;
let server: Server | null = null;
let port = 0;
let received: Received[] = [];
let webhooks: Webhooks | null = null;

function headersToRecord(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (Array.isArray(v)) out[k] = v.join(',');
    else if (typeof v === 'string') out[k] = v;
  }
  return out;
}

async function startServer(
  handler: (count: number) => { status: number; body?: string },
): Promise<void> {
  return new Promise((resolve) => {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      received.push({
        headers: headersToRecord(req.headers),
        body: raw ? JSON.parse(raw) : null,
        raw,
      });
      const r = handler(received.length);
      res.statusCode = r.status;
      res.end(r.body ?? '');
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      if (addr && typeof addr === 'object') port = addr.port;
      resolve();
    });
  });
}

async function stopServer(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  stepMs = 25,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'webhooks-test-'));
  received = [];
});

afterEach(async () => {
  if (webhooks) {
    await webhooks.close();
    webhooks = null;
  }
  await stopServer();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('createWebhooks', () => {
  it('emit() returns immediately and delivers asynchronously with a signed body', async () => {
    await startServer(() => ({ status: 200 }));
    webhooks = createWebhooks({
      dbPath: join(tmpDir, 'w.db'),
      signingSecret: 'shh',
      pollIntervalMs: 50,
    });
    await webhooks.register('order.created', `http://127.0.0.1:${port}/hook`);

    const t0 = Date.now();
    await webhooks.emit('order.created', { orderId: 1 });
    const emitMs = Date.now() - t0;

    expect(emitMs).toBeLessThan(50); // bounded by a local DB tx

    await waitFor(() => received.length >= 1);
    const r = received[0]!;
    expect(r.body).toEqual({ orderId: 1 });
    expect(r.headers['x-webhook-event']).toBe('order.created');
    expect(r.headers['x-webhook-delivery-id']).toMatch(/^[0-9a-f-]{36}$/);

    const ts = r.headers['x-webhook-timestamp']!;
    const sig = r.headers['x-webhook-signature']!;
    expect(verify('shh', ts, r.raw, sig)).toBe(true);
    expect(verify('wrong', ts, r.raw, sig)).toBe(false);
  });

  it('fans out to multiple subscribers', async () => {
    await startServer(() => ({ status: 200 }));
    webhooks = createWebhooks({
      dbPath: join(tmpDir, 'w.db'),
      signingSecret: 'shh',
      pollIntervalMs: 50,
    });
    await webhooks.register('order.created', `http://127.0.0.1:${port}/a`);
    await webhooks.register('order.created', `http://127.0.0.1:${port}/b`);
    await webhooks.emit('order.created', { x: 1 });

    await waitFor(() => received.length >= 2);
    expect(received).toHaveLength(2);
    expect(received.every((r) => (r.body as { x: number }).x === 1)).toBe(true);
  });

  it('retries a failing subscriber until it succeeds', async () => {
    await startServer((count) =>
      count < 3 ? { status: 500, body: 'boom' } : { status: 200 },
    );
    webhooks = createWebhooks({
      dbPath: join(tmpDir, 'w.db'),
      signingSecret: 'shh',
      baseRetryDelayMs: 30,
      maxRetryDelayMs: 100,
      pollIntervalMs: 30,
    });
    await webhooks.register('order.created', `http://127.0.0.1:${port}/hook`);
    await webhooks.emit('order.created', { orderId: 7 });

    await waitFor(() => received.length >= 3, 5_000);
    expect(received).toHaveLength(3);
    // All three carry the same delivery id (same row, retried).
    const id = received[0]!.headers['x-webhook-delivery-id']!;
    expect(received.every((r) => r.headers['x-webhook-delivery-id'] === id)).toBe(true);
  });

  it('marks deliveries dead after maxAttempts', async () => {
    await startServer(() => ({ status: 500, body: 'always fails' }));
    webhooks = createWebhooks({
      dbPath: join(tmpDir, 'w.db'),
      signingSecret: 'shh',
      maxAttempts: 3,
      baseRetryDelayMs: 20,
      maxRetryDelayMs: 50,
      pollIntervalMs: 20,
    });
    await webhooks.register('order.created', `http://127.0.0.1:${port}/hook`);
    const { deliveryIds } = await webhooks.emit('order.created', { x: 1 });

    await waitFor(() => received.length >= 3);
    // Give the worker a moment to write the final state.
    await new Promise((r) => setTimeout(r, 100));

    // Inspect the DB directly — there's no public getter for status yet.
    const db = new Database(join(tmpDir, 'w.db'));
    const row = db
      .prepare(`SELECT status, attempts FROM deliveries WHERE id = ?`)
      .get(deliveryIds[0]!) as { status: string; attempts: number };
    db.close();
    expect(row.status).toBe('dead');
    expect(row.attempts).toBe(3);
  });

  it('recovers pending deliveries across a process restart', async () => {
    await startServer(() => ({ status: 200 }));
    const dbPath = join(tmpDir, 'w.db');

    // Boot 1: enqueue with worker disabled — simulates a process that
    // committed deliveries and then died before sending any HTTP.
    const w1 = createWebhooks({
      dbPath,
      signingSecret: 'shh',
      autoStart: false,
    });
    await w1.register('order.created', `http://127.0.0.1:${port}/hook`);
    await w1.emit('order.created', { orderId: 42 });
    await w1.close();
    expect(received).toHaveLength(0);

    // Boot 2: fresh process, worker auto-starts, delivery should complete.
    webhooks = createWebhooks({
      dbPath,
      signingSecret: 'shh',
      pollIntervalMs: 30,
    });
    await waitFor(() => received.length >= 1);
    expect(received[0]!.body).toEqual({ orderId: 42 });
  });

  it('redelivers in-flight rows after a simulated mid-flight crash', async () => {
    await startServer(() => ({ status: 200 }));
    const dbPath = join(tmpDir, 'w.db');

    // Boot 1: enqueue, then mutate the DB to simulate a worker that
    // claimed and started dispatching but never wrote the result.
    const w1 = createWebhooks({ dbPath, signingSecret: 'shh', autoStart: false });
    await w1.register('order.created', `http://127.0.0.1:${port}/hook`);
    const { deliveryIds } = await w1.emit('order.created', { orderId: 99 });
    await w1.close();

    const db = new Database(dbPath);
    db.prepare(
      `UPDATE deliveries SET status = 'dispatching', attempts = 1 WHERE id = ?`,
    ).run(deliveryIds[0]!);
    db.close();

    // Boot 2: must reset the dispatching row to pending and deliver it.
    webhooks = createWebhooks({
      dbPath,
      signingSecret: 'shh',
      pollIntervalMs: 30,
    });
    await waitFor(() => received.length >= 1);
    expect(received[0]!.body).toEqual({ orderId: 99 });
  });

  it('sweeps expired leases without restarting the process', async () => {
    // Proves the in-process redrive path: a row whose lease has expired
    // (worker hung mid-fetch but the process is still alive) gets reset
    // by the next polling tick and redelivered.
    await startServer(() => ({ status: 200 }));
    const dbPath = join(tmpDir, 'w.db');

    webhooks = createWebhooks({
      dbPath,
      signingSecret: 'shh',
      requestTimeoutMs: 100,
      leaseMs: 200,
      pollIntervalMs: 50,
    });
    await webhooks.register('order.created', `http://127.0.0.1:${port}/hook`);
    const { deliveryIds } = await webhooks.emit('order.created', { orderId: 1 });

    // Wait for the row to be delivered normally first, then forcibly back
    // it up into 'dispatching' with an expired lease — same as if the
    // current process had hung in fetch() and never written 'delivered'.
    await waitFor(() => received.length >= 1);
    received.length = 0;

    const db = new Database(dbPath);
    db.prepare(
      `UPDATE deliveries
       SET status = 'dispatching', lease_expires_at = ?, attempts = 1
       WHERE id = ?`,
    ).run(Date.now() - 1_000, deliveryIds[0]!);
    db.close();

    // The next poll tick should sweep the expired lease, reset to pending,
    // and redeliver — without us touching the process.
    await waitFor(() => received.length >= 1, 3_000);
    expect(received[0]!.headers['x-webhook-delivery-id']).toBe(deliveryIds[0]!);
  });

  it('listDead() returns dead-lettered deliveries', async () => {
    await startServer(() => ({ status: 500, body: 'always fails' }));
    webhooks = createWebhooks({
      dbPath: join(tmpDir, 'w.db'),
      signingSecret: 'shh',
      maxAttempts: 2,
      baseRetryDelayMs: 10,
      maxRetryDelayMs: 30,
      pollIntervalMs: 20,
    });
    await webhooks.register('order.created', `http://127.0.0.1:${port}/hook`);
    await webhooks.emit('order.created', { orderId: 1 });

    await waitFor(() => received.length >= 2);
    // Give the worker a moment to write the final 'dead' state.
    await waitFor(async () => (await webhooks!.listDead()).length >= 1, 2_000);

    const dead = await webhooks.listDead();
    expect(dead).toHaveLength(1);
    expect(dead[0]!.status).toBe('dead');
    expect(dead[0]!.attempts).toBe(2);
    expect(dead[0]!.lastError).toMatch(/HTTP 500/);
  });

  it('requeue() moves a dead delivery back to pending and redelivers it', async () => {
    let succeed = false;
    await startServer(() =>
      succeed ? { status: 200 } : { status: 500, body: 'fail' },
    );
    webhooks = createWebhooks({
      dbPath: join(tmpDir, 'w.db'),
      signingSecret: 'shh',
      maxAttempts: 2,
      baseRetryDelayMs: 10,
      maxRetryDelayMs: 30,
      pollIntervalMs: 20,
    });
    await webhooks.register('order.created', `http://127.0.0.1:${port}/hook`);
    await webhooks.emit('order.created', { orderId: 1 });

    // Wait for the delivery to land in 'dead'.
    await waitFor(async () => (await webhooks!.listDead()).length >= 1, 2_000);
    const beforeCount = received.length;

    // Now flip the receiver to "succeed" and requeue.
    succeed = true;
    const dead = await webhooks.listDead();
    const result = await webhooks.requeue(dead[0]!.id);
    expect(result.ok).toBe(true);

    await waitFor(() => received.length > beforeCount, 2_000);
    // The redelivery uses the same row, so its delivery-id matches.
    const last = received[received.length - 1]!;
    expect(last.headers['x-webhook-delivery-id']).toBe(dead[0]!.id);
    expect(await webhooks.listDead()).toHaveLength(0);
  });

  it('rejects leaseMs <= requestTimeoutMs at construction', () => {
    expect(() =>
      createWebhooks({
        dbPath: join(tmpDir, 'w.db'),
        signingSecret: 'shh',
        requestTimeoutMs: 5_000,
        leaseMs: 1_000,
      }),
    ).toThrow(/leaseMs.*must be greater than requestTimeoutMs/);
  });

  it('marks 4xx failures dead on the first attempt without retrying', async () => {
    await startServer(() => ({ status: 400, body: 'malformed payload' }));
    webhooks = createWebhooks({
      dbPath: join(tmpDir, 'w.db'),
      signingSecret: 'shh',
      maxAttempts: 8,
      baseRetryDelayMs: 10,
      maxRetryDelayMs: 30,
      pollIntervalMs: 20,
    });
    await webhooks.register('order.created', `http://127.0.0.1:${port}/hook`);
    const { deliveryIds } = await webhooks.emit('order.created', { orderId: 1 });

    // Wait for the row to land in 'dead'.
    await waitFor(async () => (await webhooks!.listDead()).length >= 1, 2_000);
    // Give a moment for any straggler retries that shouldn't happen.
    await new Promise((r) => setTimeout(r, 200));

    // The receiver should have been hit exactly once — no retries on 4xx.
    expect(received).toHaveLength(1);

    const dead = await webhooks.listDead();
    expect(dead).toHaveLength(1);
    expect(dead[0]!.id).toBe(deliveryIds[0]!);
    expect(dead[0]!.attempts).toBe(1);
    expect(dead[0]!.lastError).toMatch(/HTTP 400/);
  });

  it('still retries 408 and 429 (transient 4xx)', async () => {
    let attemptCount = 0;
    await startServer(() => {
      attemptCount += 1;
      // 408 first, then 429, then succeed.
      if (attemptCount === 1) return { status: 408, body: 'timeout' };
      if (attemptCount === 2) return { status: 429, body: 'rate limited' };
      return { status: 200 };
    });

    webhooks = createWebhooks({
      dbPath: join(tmpDir, 'w.db'),
      signingSecret: 'shh',
      maxAttempts: 5,
      baseRetryDelayMs: 20,
      maxRetryDelayMs: 50,
      pollIntervalMs: 20,
    });
    await webhooks.register('order.created', `http://127.0.0.1:${port}/hook`);
    await webhooks.emit('order.created', { orderId: 1 });

    await waitFor(() => received.length >= 3, 3_000);
    expect(received).toHaveLength(3);
    expect(await webhooks.listDead()).toHaveLength(0);
  });

  it('migrates an old database (no lease_expires_at column) on open', async () => {
    const dbPath = join(tmpDir, 'legacy.db');

    // Stand up the receiver first so we know the live port.
    await startServer(() => ({ status: 200 }));

    // Create a DB with the pre-lease schema, populate it as a previous
    // process would have done, then close.
    {
      const legacy = new Database(dbPath);
      legacy.exec(`
        CREATE TABLE deliveries (
          id              TEXT PRIMARY KEY,
          event_name      TEXT NOT NULL,
          payload         TEXT NOT NULL,
          subscriber_id   TEXT NOT NULL,
          url             TEXT NOT NULL,
          status          TEXT NOT NULL CHECK (status IN ('pending','claimed','dispatching','delivered','dead')),
          attempts        INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL,
          last_error      TEXT,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL
        );
        CREATE TABLE subscribers (
          id          TEXT PRIMARY KEY,
          event_name  TEXT NOT NULL,
          url         TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          UNIQUE(event_name, url)
        );
      `);
      const now = Date.now();
      legacy
        .prepare(
          `INSERT INTO deliveries
             (id, event_name, payload, subscriber_id, url, status, attempts,
              next_attempt_at, last_error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?)`,
        )
        .run(
          'legacy-row-id',
          'order.created',
          JSON.stringify({ legacy: true }),
          'legacy-sub-id',
          `http://127.0.0.1:${port}/hook`,
          now - 1_000,
          now,
          now,
        );
      legacy.close();
    }

    // Open the DB through createWebhooks — this triggers migrate().
    webhooks = createWebhooks({
      dbPath,
      signingSecret: 'shh',
      pollIntervalMs: 30,
    });

    // The schema should now include the new column.
    const probe = new Database(dbPath, { readonly: true });
    const cols = probe.prepare(`PRAGMA table_info(deliveries)`).all() as Array<{
      name: string;
    }>;
    probe.close();
    expect(cols.some((c) => c.name === 'lease_expires_at')).toBe(true);

    // The legacy row's data must be intact AND deliverable.
    await waitFor(() => received.length >= 1, 2_000);
    expect(received[0]!.body).toEqual({ legacy: true });
    expect(received[0]!.headers['x-webhook-delivery-id']).toBe('legacy-row-id');
  });
});
