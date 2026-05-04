export function nextDelayMs(
  attemptNumber: number,
  baseMs: number,
  capMs: number,
): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attemptNumber - 1));
  // Equal jitter: half deterministic, half random. Spreads thundering herds
  // without collapsing the lower bound to zero.
  const jitter = Math.random() * (exp / 2);
  return Math.floor(exp / 2 + jitter);
}
