// Stripe webhook: verifies signature, then forwards confirmed payments to Vision Control.
const crypto = require('crypto');
const { forward } = require('./event');
const { parseStripeSignature, computeStripeSignature, clampString } = require('./_shared');

const MAX_BODY_BYTES = 256 * 1024; // 256 KB
const TOLERANCE_SECONDS = 300;

async function readRawBody(req) {
  // Vercel hands us a stream when bodyParser is disabled; fall back to any pre-buffered body (tests / other runtimes).
  if (req && typeof req[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        const err = new Error('Payload too large');
        err.statusCode = 413;
        throw err;
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }
  const b = req && (req.rawBody !== undefined ? req.rawBody : req.body);
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(typeof b === 'string' ? b : JSON.stringify(b || {}));
  if (buf.length > MAX_BODY_BYTES) {
    const err = new Error('Payload too large');
    err.statusCode = 413;
    throw err;
  }
  return buf;
}

function verifySignature(secret, header, raw, nowSeconds) {
  const { t, v1 } = parseStripeSignature(header);
  if (!Number.isFinite(t) || t <= 0 || v1.length === 0) return false;
  if (Math.abs(nowSeconds - t) > TOLERANCE_SECONDS) return false; // replay / clock-skew guard
  const expected = Buffer.from(computeStripeSignature(secret, t, raw), 'hex');
  // Any matching v1 is enough: Stripe sends one per active secret while a secret is being rotated.
  let matched = false;
  v1.forEach((candidate) => {
    const candidateBuf = Buffer.from(candidate, 'hex');
    if (candidateBuf.length === expected.length && crypto.timingSafeEqual(candidateBuf, expected)) matched = true;
  });
  return matched;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(500).end();

  let raw;
  try {
    raw = await readRawBody(req);
  } catch (e) {
    return res.status(e.statusCode || 400).end();
  }

  const header = (req.headers && (req.headers['stripe-signature'] || req.headers['Stripe-Signature'])) || '';
  if (!verifySignature(secret, header, raw, Date.now() / 1000)) return res.status(400).end();

  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch (_) {
    return res.status(400).end();
  }
  if (!event || typeof event !== 'object') return res.status(400).end();

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data && event.data.object;
    if (!pi || typeof pi !== 'object') return res.status(400).end();
    const m = pi.metadata && typeof pi.metadata === 'object' ? pi.metadata : {};
    const c = (v) => clampString(v, 500);
    try {
      await forward({
        source: 'thrive-funnel', type: 'payment', ts: new Date().toISOString(),
        data: {
          paymentIntent: c(pi.id),
          amount: Number.isFinite(pi.amount) ? pi.amount : 0,
          currency: c(pi.currency),
          session_date: c(m.session_date),
          session_time: c(m.session_time),
        },
        lead: { fn: c(m.first_name), ln: c(m.last_name), org: c(m.organization), em: c(m.email), ph: c(m.phone) },
      });
    } catch (e) { console.error(e); return res.status(502).end(); }
  }
  res.status(200).json({ received: true });
};

module.exports.config = { api: { bodyParser: false } };
module.exports.verifySignature = verifySignature;
module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
