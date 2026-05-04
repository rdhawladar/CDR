import express from 'express';
import { verify } from '../../src/index.js';

const SECRET = process.env.WEBHOOK_SECRET ?? 'example-secret';
const PORT = Number(process.env.PORT ?? 4001);

// Track delivery IDs we've already processed so a redelivery is a no-op.
// The webhook contract is at-least-once, so receivers MUST be idempotent.
const seen = new Set<string>();
let totalAttempts = 0;
const FAIL_UNTIL = Number(process.env.FAIL_UNTIL ?? 0);

const app = express();

// Capture the raw body for HMAC verification — express.json() would mutate it.
app.use(
  express.raw({ type: 'application/json', limit: '1mb' }),
);

app.post('/hook', (req, res) => {
  const id = String(req.header('x-webhook-delivery-id') ?? '');
  const ts = String(req.header('x-webhook-timestamp') ?? '');
  const sig = String(req.header('x-webhook-signature') ?? '');
  const event = String(req.header('x-webhook-event') ?? '');
  const raw = (req.body as Buffer).toString('utf8');

  if (!verify(SECRET, ts, raw, sig)) {
    console.warn(`[receiver] BAD SIGNATURE for delivery ${id}`);
    res.status(401).end('bad signature');
    return;
  }

  if (seen.has(id)) {
    console.log(`[receiver] duplicate delivery ${id} ignored (at-least-once)`);
    res.status(200).end('duplicate-ok');
    return;
  }

  totalAttempts += 1;
  if (totalAttempts <= FAIL_UNTIL) {
    console.log(
      `[receiver] forcing failure ${totalAttempts}/${FAIL_UNTIL} for ${event} ${id}`,
    );
    res.status(503).end('temporarily failing');
    return;
  }

  seen.add(id);
  console.log(`[receiver] OK ${event} delivery=${id} body=${raw}`);
  res.status(200).end('ok');
});

app.listen(PORT, () => {
  console.log(`[receiver] listening on http://127.0.0.1:${PORT}/hook`);
  console.log(`[receiver] secret=${SECRET} failUntil=${process.env.FAIL_UNTIL ?? 0}`);
});
