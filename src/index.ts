import { Store } from './store.js';
import { Worker } from './worker.js';
import type { Webhooks, WebhooksConfig } from './types.js';

export type {
  Webhooks,
  WebhooksConfig,
  Delivery,
  DeliveryStatus,
  Subscriber,
  ListDeadOptions,
} from './types.js';
export { sign, verify } from './signing.js';

export function createWebhooks(config: WebhooksConfig): Webhooks {
  if (!config.signingSecret) {
    throw new Error('createWebhooks: signingSecret is required');
  }

  const requestTimeoutMs = config.requestTimeoutMs ?? 10_000;
  const leaseMs = config.leaseMs ?? 60_000;
  if (leaseMs <= requestTimeoutMs) {
    throw new Error(
      `createWebhooks: leaseMs (${leaseMs}) must be greater than requestTimeoutMs (${requestTimeoutMs})`,
    );
  }

  const store = new Store(config.dbPath ?? './webhooks.db');
  const worker = new Worker({
    store,
    signingSecret: config.signingSecret,
    maxAttempts: config.maxAttempts ?? 8,
    baseRetryDelayMs: config.baseRetryDelayMs ?? 1_000,
    maxRetryDelayMs: config.maxRetryDelayMs ?? 60_000,
    requestTimeoutMs,
    pollIntervalMs: config.pollIntervalMs ?? 5_000,
    leaseMs,
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
      worker.wakeup();
      return { deliveryIds: ids };
    },

    async listDead(options) {
      const limit = options?.limit ?? 100;
      const offset = options?.offset ?? 0;
      return store.listDead(limit, offset);
    },

    async requeue(deliveryId) {
      const ok = store.requeue(deliveryId);
      if (ok) worker.wakeup();
      return { ok };
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
