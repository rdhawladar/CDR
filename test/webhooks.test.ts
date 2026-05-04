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
  predicate: () => boolean,
  timeoutMs = 5_000,
  stepMs = 25,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
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
});
