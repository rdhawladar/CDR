export type DeliveryStatus =
  | 'pending'
  | 'claimed'
  | 'dispatching'
  | 'delivered'
  | 'dead';

export type Subscriber = {
  id: string;
  eventName: string;
  url: string;
  createdAt: number;
};

export type Delivery = {
  id: string;
  eventName: string;
  payload: string;
  subscriberId: string;
  url: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

export type WebhooksConfig = {
  /** Path to the SQLite database file. Defaults to './webhooks.db'. */
  dbPath?: string;
  /** Secret used for HMAC-SHA256 signing of outgoing webhooks. */
  signingSecret: string;
  /** Maximum delivery attempts before marking a delivery 'dead'. Default 8. */
  maxAttempts?: number;
  /** Base retry delay in ms; backoff is base * 2^(attempts-1) with jitter. Default 1000. */
  baseRetryDelayMs?: number;
  /** Cap on retry delay in ms. Default 60_000. */
  maxRetryDelayMs?: number;
  /** HTTP request timeout in ms. Default 10_000. */
  requestTimeoutMs?: number;
  /** Polling tick interval (lease sweep + retries due). Default 5_000. */
  pollIntervalMs?: number;
  /** Disable automatic worker start (useful for tests). Default false. */
  autoStart?: boolean;
};

export type Webhooks = {
  /** Register a subscriber URL for an event. Resolves once persisted. */
  register(eventName: string, url: string): Promise<{ id: string }>;
  /** Emit an event. Returns once delivery rows are durably persisted. */
  emit(eventName: string, payload: unknown): Promise<{ deliveryIds: string[] }>;
  /** Manually start the dispatch worker (only needed if autoStart=false). */
  start(): void;
  /** Stop the worker and close the database. */
  close(): Promise<void>;
};
