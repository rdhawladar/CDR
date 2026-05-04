import { createWebhooks } from '../../src/index.js';

const SECRET = process.env.WEBHOOK_SECRET ?? 'example-secret';
const RECEIVER = process.env.RECEIVER_URL ?? 'http://127.0.0.1:4001/hook';
const DB_PATH = process.env.DB_PATH ?? './webhooks.db';

async function main(): Promise<void> {
  const webhooks = createWebhooks({
    dbPath: DB_PATH,
    signingSecret: SECRET,
    baseRetryDelayMs: 250,
    maxRetryDelayMs: 2_000,
    pollIntervalMs: 500,
  });

  // Idempotent — registering the same (event, url) twice is a no-op.
  await webhooks.register('order.created', RECEIVER);

  const orderId = Math.floor(Math.random() * 100_000);
  const t0 = Date.now();
  const { deliveryIds } = await webhooks.emit('order.created', {
    orderId,
    placedAt: new Date().toISOString(),
  });
  const ms = Date.now() - t0;

  console.log(
    `[emitter] emit() returned in ${ms}ms with ${deliveryIds.length} delivery(s) queued`,
  );
  console.log(`[emitter] orderId=${orderId} deliveryIds=${deliveryIds.join(',')}`);

  // Give the worker a few seconds to drain before exiting. Real applications
  // own this lifetime via their HTTP server / process supervisor; here we
  // just want a tidy one-shot demo.
  const drainMs = Number(process.env.DRAIN_MS ?? 6_000);
  console.log(`[emitter] draining for ${drainMs}ms then closing...`);
  await new Promise((r) => setTimeout(r, drainMs));
  await webhooks.close();
  console.log('[emitter] closed cleanly');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
