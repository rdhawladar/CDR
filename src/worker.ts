import { nextDelayMs } from './backoff.js';
import { sign } from './signing.js';
import type { Store } from './store.js';
import type { Delivery } from './types.js';

type WorkerOptions = {
  store: Store;
  signingSecret: string;
  maxAttempts: number;
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
  requestTimeoutMs: number;
  pollIntervalMs: number;
  /** Lease length for claimed rows. Must be > requestTimeoutMs. */
  leaseMs: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

const BATCH_SIZE = 50;

export class Worker {
  private readonly opts: Required<Omit<WorkerOptions, 'fetchImpl'>> & {
    fetchImpl: typeof fetch;
  };
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private wakeupScheduled = false;
  private stopped = false;

  constructor(opts: WorkerOptions) {
    this.opts = {
      ...opts,
      fetchImpl: opts.fetchImpl ?? globalThis.fetch.bind(globalThis),
    };
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    // Boot recovery: previous process is gone, blanket-reset its in-flight rows.
    this.opts.store.recoverInflight();
    this.timer = setInterval(() => this.wakeup(), this.opts.pollIntervalMs);
    // Allow the process to exit naturally even if the worker is idle.
    this.timer.unref();
    this.wakeup();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Wait for any in-progress drain to finish so we don't write
    // to a closed DB after stop() resolves.
    while (this.draining) {
      await new Promise((r) => setImmediate(r));
    }
  }

  /** Schedule a drain on the next tick. Cheap and idempotent. */
  wakeup(): void {
    if (this.stopped || this.wakeupScheduled || this.draining) return;
    this.wakeupScheduled = true;
    setImmediate(() => {
      this.wakeupScheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.stopped || this.draining) return;
    this.draining = true;
    try {
      // Per-tick: redrive any in-flight row whose lease expired (a worker
      // hung mid-fetch in this same process). Boot recovery handles the
      // crashed-process case; this handles the still-alive-but-stuck case.
      this.opts.store.sweepExpiredLeases();

      // Drain in waves so a long subscriber doesn't starve newer events.
      for (let i = 0; i < 3; i++) {
        if (this.stopped) break;
        const batch = this.opts.store.claimDue(BATCH_SIZE, this.opts.leaseMs);
        if (batch.length === 0) break;
        await Promise.allSettled(batch.map((d) => this.dispatch(d)));
      }
    } finally {
      this.draining = false;
    }
  }

  private async dispatch(delivery: Delivery): Promise<void> {
    if (this.stopped) return;
    // Critical: write 'dispatching' to disk BEFORE awaiting the network
    // request, so a crash mid-fetch is recoverable on next boot.
    // Refreshes the lease so a slow-but-healthy fetch isn't reaped.
    this.opts.store.markDispatching(delivery.id, this.opts.leaseMs);

    const timestamp = String(Date.now());
    const body = delivery.payload;
    const signature = sign(this.opts.signingSecret, timestamp, body);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.requestTimeoutMs);

    try {
      const res = await this.opts.fetchImpl(delivery.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-webhook-event': delivery.eventName,
          'x-webhook-delivery-id': delivery.id,
          'x-webhook-timestamp': timestamp,
          'x-webhook-signature': signature,
        },
        body,
        signal: controller.signal,
      });

      if (res.ok) {
        this.opts.store.markDelivered(delivery.id);
        return;
      }

      const text = await res.text().catch(() => '');
      this.recordFailure(delivery, `HTTP ${res.status}: ${text.slice(0, 500)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.recordFailure(delivery, msg);
    } finally {
      clearTimeout(timeout);
    }
  }

  private recordFailure(delivery: Delivery, error: string): void {
    const nextAttempt = delivery.attempts + 1;
    const isDead = nextAttempt >= this.opts.maxAttempts;
    const delay = nextDelayMs(
      nextAttempt,
      this.opts.baseRetryDelayMs,
      this.opts.maxRetryDelayMs,
    );
    this.opts.store.markFailed(
      delivery.id,
      error,
      Date.now() + delay,
      isDead,
    );
  }
}
