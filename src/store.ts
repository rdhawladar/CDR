import Database, { type Database as DB } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Delivery, DeliveryStatus, Subscriber } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS subscribers (
  id          TEXT PRIMARY KEY,
  event_name  TEXT NOT NULL,
  url         TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE(event_name, url)
);
CREATE INDEX IF NOT EXISTS subscribers_event ON subscribers(event_name);

CREATE TABLE IF NOT EXISTS deliveries (
  id               TEXT PRIMARY KEY,
  event_name       TEXT NOT NULL,
  payload          TEXT NOT NULL,
  subscriber_id    TEXT NOT NULL,
  url              TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending','claimed','dispatching','delivered','dead')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL,
  last_error       TEXT,
  lease_expires_at INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS deliveries_lease ON deliveries(status, lease_expires_at);
`;

type SubscriberRow = {
  id: string;
  event_name: string;
  url: string;
  created_at: number;
};

type DeliveryRow = {
  id: string;
  event_name: string;
  payload: string;
  subscriber_id: string;
  url: string;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
};

function toSubscriber(r: SubscriberRow): Subscriber {
  return { id: r.id, eventName: r.event_name, url: r.url, createdAt: r.created_at };
}

function toDelivery(r: DeliveryRow): Delivery {
  return {
    id: r.id,
    eventName: r.event_name,
    payload: r.payload,
    subscriberId: r.subscriber_id,
    url: r.url,
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    lastError: r.last_error,
    leaseExpiresAt: r.lease_expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class Store {
  private readonly db: DB;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Idempotent forward migration. SQLite's ALTER TABLE ADD COLUMN is itself
   * non-idempotent, so we only fire it when the column is missing.
   */
  private migrate(): void {
    const cols = this.db.prepare(`PRAGMA table_info(deliveries)`).all() as Array<{
      name: string;
    }>;
    if (!cols.some((c) => c.name === 'lease_expires_at')) {
      this.db.exec(`ALTER TABLE deliveries ADD COLUMN lease_expires_at INTEGER`);
      this.db.exec(
        `CREATE INDEX IF NOT EXISTS deliveries_lease ON deliveries(status, lease_expires_at)`,
      );
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * On boot, blanket-reset any row that was claimed or dispatching when the
   * previous process died. The lease can't be trusted across processes —
   * we know the previous worker is gone.
   */
  recoverInflight(now: number = Date.now()): number {
    const result = this.db
      .prepare(
        `UPDATE deliveries
         SET status = 'pending', updated_at = ?, next_attempt_at = ?, lease_expires_at = NULL
         WHERE status IN ('claimed','dispatching')`,
      )
      .run(now, now);
    return result.changes;
  }

  /**
   * Per-tick sweep: reset any in-flight row whose lease has expired. Used by
   * a long-running worker to recover rows whose dispatcher hung mid-fetch.
   * Distinct from recoverInflight() — this only touches expired leases, not
   * healthy in-progress rows.
   */
  sweepExpiredLeases(now: number = Date.now()): number {
    const result = this.db
      .prepare(
        `UPDATE deliveries
         SET status = 'pending', updated_at = ?, next_attempt_at = ?, lease_expires_at = NULL
         WHERE status IN ('claimed','dispatching') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      )
      .run(now, now, now);
    return result.changes;
  }

  registerSubscriber(eventName: string, url: string, now: number = Date.now()): Subscriber {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO subscribers (id, event_name, url, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(event_name, url) DO NOTHING`,
      )
      .run(id, eventName, url, now);
    const row = this.db
      .prepare(`SELECT * FROM subscribers WHERE event_name = ? AND url = ?`)
      .get(eventName, url) as SubscriberRow;
    return toSubscriber(row);
  }

  listSubscribers(eventName: string): Subscriber[] {
    const rows = this.db
      .prepare(`SELECT * FROM subscribers WHERE event_name = ? ORDER BY created_at`)
      .all(eventName) as SubscriberRow[];
    return rows.map(toSubscriber);
  }

  enqueueFanout(eventName: string, payload: string, now: number = Date.now()): string[] {
    const subs = this.listSubscribers(eventName);
    if (subs.length === 0) return [];

    const insert = this.db.prepare(
      `INSERT INTO deliveries
       (id, event_name, payload, subscriber_id, url, status, attempts, next_attempt_at, last_error, lease_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, ?)`,
    );

    const ids: string[] = [];
    const tx = this.db.transaction(() => {
      for (const s of subs) {
        const id = randomUUID();
        insert.run(id, eventName, payload, s.id, s.url, now, now, now);
        ids.push(id);
      }
    });
    tx();
    return ids;
  }

  /**
   * Atomically claim up to `limit` deliveries that are due. Each claimed
   * row is stamped with a lease expiring at `now + leaseMs`. If a worker
   * dies mid-fetch, the next sweep tick will reset the row.
   */
  claimDue(limit: number, leaseMs: number, now: number = Date.now()): Delivery[] {
    const due = this.db
      .prepare(
        `SELECT id FROM deliveries
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at
         LIMIT ?`,
      )
      .all(now, limit) as Array<{ id: string }>;

    if (due.length === 0) return [];

    const leaseExpiresAt = now + leaseMs;
    const claim = this.db.prepare(
      `UPDATE deliveries
       SET status = 'claimed', updated_at = ?, lease_expires_at = ?
       WHERE id = ? AND status = 'pending'`,
    );
    const fetch = this.db.prepare(`SELECT * FROM deliveries WHERE id = ?`);

    const claimed: Delivery[] = [];
    const tx = this.db.transaction(() => {
      for (const { id } of due) {
        const r = claim.run(now, leaseExpiresAt, id);
        if (r.changes === 1) {
          claimed.push(toDelivery(fetch.get(id) as DeliveryRow));
        }
      }
    });
    tx();
    return claimed;
  }

  /**
   * Mark a claimed row as dispatching, immediately before awaiting fetch().
   * Refreshes the lease so a slow-but-healthy fetch isn't reaped by the sweeper.
   */
  markDispatching(id: string, leaseMs: number, now: number = Date.now()): void {
    this.db
      .prepare(
        `UPDATE deliveries
         SET status = 'dispatching', attempts = attempts + 1, updated_at = ?, lease_expires_at = ?
         WHERE id = ? AND status = 'claimed'`,
      )
      .run(now, now + leaseMs, id);
  }

  markDelivered(id: string, now: number = Date.now()): void {
    this.db
      .prepare(
        `UPDATE deliveries
         SET status = 'delivered', last_error = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, id);
  }

  /** Schedule a retry, or mark dead if attempts has reached the cap. */
  markFailed(
    id: string,
    error: string,
    nextAttemptAt: number,
    isDead: boolean,
    now: number = Date.now(),
  ): void {
    this.db
      .prepare(
        `UPDATE deliveries
         SET status = ?, last_error = ?, next_attempt_at = ?, lease_expires_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(isDead ? 'dead' : 'pending', error, nextAttemptAt, now, id);
  }

  countByStatus(status: DeliveryStatus): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM deliveries WHERE status = ?`)
      .get(status) as { c: number };
    return row.c;
  }

  getDelivery(id: string): Delivery | null {
    const row = this.db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(id) as
      | DeliveryRow
      | undefined;
    return row ? toDelivery(row) : null;
  }

  /** List dead-lettered deliveries, newest first. */
  listDead(limit: number, offset: number): Delivery[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM deliveries
         WHERE status = 'dead'
         ORDER BY updated_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as DeliveryRow[];
    return rows.map(toDelivery);
  }

  /**
   * Move a dead row back to pending so it can be retried by the worker.
   * Resets the attempt counter — the operator is explicitly asking for a
   * fresh shot. Returns true iff a row was actually requeued.
   */
  requeue(id: string, now: number = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE deliveries
         SET status = 'pending', attempts = 0, last_error = NULL,
             lease_expires_at = NULL, next_attempt_at = ?, updated_at = ?
         WHERE id = ? AND status = 'dead'`,
      )
      .run(now, now, id);
    return result.changes === 1;
  }
}
