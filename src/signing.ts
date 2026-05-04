import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_PREFIX = 'sha256=';

export function sign(secret: string, timestamp: string, body: string): string {
  const mac = createHmac('sha256', secret);
  mac.update(`${timestamp}.${body}`);
  return SIGNATURE_PREFIX + mac.digest('hex');
}

/**
 * Verify a webhook signature. Returns true iff the signature matches AND
 * the timestamp is within `toleranceSeconds` of `now` (default 5 minutes).
 * Designed for receivers — exported so consumers can use it from the example app.
 */
export function verify(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
  toleranceSeconds = 300,
  now: number = Date.now(),
): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now - ts) > toleranceSeconds * 1000) return false;

  const expected = sign(secret, timestamp, body);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
