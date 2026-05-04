import { Store } from './store.js';
import { Worker } from './worker.js';
import type { Webhooks, WebhooksConfig } from './types.js';

export type { Webhooks, WebhooksConfig, Delivery, DeliveryStatus, Subscriber } from './types.js';
export { sign, verify } from './signing.js';

export function createWebhooks(config: WebhooksConfig): Webhooks {
  if (!config.signingSecret) {
    throw new Error('createWebhooks: signingSecret is required');
  }

  const store = new Store(config.dbPath ?? './webhooks.db');
  const worker = new Worker({
    store,
    signingSecret: config.signingSecret,
    maxAttempts: config.maxAttempts ?? 8,
    baseRetryDelayMs: config.baseRetryDelayMs ?? 1_000,
    maxRetryDelayMs: config.maxRetryDelayMs ?? 60_000,
    requestTimeoutMs: config.requestTimeoutMs ?? 10_000,
    pollIntervalMs: config.pollIntervalMs ?? 5_000,
  });

  if (config.autoStart !== false) worker.start();

  return {
    async register(eventName, url) {
      const sub = store.registerSubscriber(eventName, url);
      return { id: sub.id };
    },

    async emit(eventName, payload) {
      const body = JSON.stringify(payload);
      const ids = store.enqueueFanout(eventName, body);
      // Nudge the worker — does not await any HTTP work.
      worker.wakeup();
      return { deliveryIds: ids };
    },

    start() {
      worker.start();
    },

    async close() {
      await worker.stop();
      store.close();
    },
  };
}
