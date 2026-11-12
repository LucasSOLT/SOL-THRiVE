// Shared helpers for the Vercel Serverless Functions in api/*.js.
// The leading underscore keeps Vercel from deploying this file as its own function.
const crypto = require('crypto');

// ---- Body parsing ----------------------------------------------------------
// Accepts an already-parsed object, a JSON string, a Buffer, or nothing.
// Throws an Error with `.statusCode = 400` when a string/Buffer body is not valid JSON.
function parseJsonBody(req) {
  let body = req && req.body;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    if (!body.trim()) return {};
    try {
      body = JSON.parse(body);
    } catch (_) {
      const err = new Error('Invalid JSON payload');
      err.statusCode = 400;
      throw err;
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  return body;
}

// ---- Clamping / sanitising -------------------------------------------------
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function clampString(value, max = 500) {
  if (value === undefined || value === null) return '';
  const str = typeof value === 'string' ? value : (typeof value === 'number' || typeof value === 'boolean') ? String(value) : '';
  return str.replace(CONTROL_CHARS, '').slice(0, max);
}

// Recursively clamp every string inside arbitrary JSON so payloads cannot amplify logs / webhooks.
function sanitizeDeep(value, opts = {}, depth = 0, keyName = '') {
  const o = Object.assign({ maxString: 500, longKeys: { message: 4000 }, maxKeys: 50, maxItems: 50, maxDepth: 4 }, opts);
  if (value === null || value === undefined) return value === undefined ? undefined : null;
  if (typeof value === 'string') return clampString(value, (o.longKeys && o.longKeys[keyName]) || o.maxString);
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean') return value;
  if (depth >= o.maxDepth) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, o.maxItems).map((v) => sanitizeDeep(v, o, depth + 1, keyName));
  }
  if (typeof value === 'object') {
    const out = {};
    Object.keys(value).slice(0, o.maxKeys).forEach((k) => {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') return;
      const cleaned = sanitizeDeep(value[k], o, depth + 1, k);
      if (cleaned !== undefined) out[clampString(k, 64)] = cleaned;
    });
    return out;
  }
  return undefined;
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/;
function isValidEmail(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s.length > 0 && s.length <= 254 && EMAIL_RE.test(s);
}

const HONEYPOT_KEYS = ['hp', 'honeypot', 'website', 'url', '_gotcha', 'company_website', 'hp_field'];
function hasHoneypot(...objects) {
  return objects.some((obj) => obj && typeof obj === 'object' && HONEYPOT_KEYS.some((k) => {
    const v = obj[k];
    return typeof v === 'string' ? v.trim() !== '' : Boolean(v);
  }));
}

// ---- fetch with timeout -----------------------------------------------------
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

// ---- Per-IP sliding-window rate limiter (in-memory, per warm instance) -----
const buckets = new Map();
const MAX_TRACKED_KEYS = 5000;

function getClientIp(req) {
  const h = (req && req.headers) || {};
  const fwd = h['x-forwarded-for'] || h['x-real-ip'] || '';
  const first = String(Array.isArray(fwd) ? fwd[0] : fwd).split(',')[0].trim();
  if (first) return first.slice(0, 64);
  const sock = req && (req.socket || req.connection);
  return (sock && sock.remoteAddress) ? String(sock.remoteAddress).slice(0, 64) : '';
}

/**
 * Returns true when the request may proceed. When the limit is exceeded it writes a
 * 429 + Retry-After response and returns false. Requests without an identifiable
 * client IP (e.g. in-process unit tests) are never throttled.
 */
function rateLimit(req, res, { name, limit, windowMs = 60000, now = Date.now() }) {
  const ip = getClientIp(req);
  if (!ip) return true;
  const key = `${name}:${ip}`;
  let hits = buckets.get(key) || [];
  hits = hits.filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    const retryAfter = Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'Too many requests. Please slow down.', retryAfter });
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > MAX_TRACKED_KEYS) {
    for (const [k, v] of buckets) {
      if (!v.length || now - v[v.length - 1] >= windowMs) buckets.delete(k);
      if (buckets.size <= MAX_TRACKED_KEYS * 0.8) break;
    }
  }
  return true;
}

function resetRateLimits() { buckets.clear(); }

// ---- Stripe signature helpers ------------------------------------------------
/**
 * Parses a `Stripe-Signature` header into { t, v1: [...] }. Tolerates whitespace, unknown
 * schemes and multiple `v1=` entries (sent while a webhook secret is being rolled).
 */
function parseStripeSignature(header) {
  const out = { t: NaN, v1: [] };
  String(header || '').split(',').forEach((piece) => {
    const idx = piece.indexOf('=');
    if (idx < 1) return;
    const k = piece.slice(0, idx).trim();
    const v = piece.slice(idx + 1).trim();
    if (k === 't') out.t = /^\d{1,12}$/.test(v) ? Number(v) : NaN;
    else if (k === 'v1' && /^[0-9a-fA-F]{64}$/.test(v)) out.v1.push(v.toLowerCase());
  });
  return out;
}

function computeStripeSignature(secret, timestamp, rawBuffer) {
  return crypto.createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBuffer]))
    .digest('hex');
}

module.exports = {
  parseJsonBody, clampString, sanitizeDeep, isValidEmail, hasHoneypot, fetchWithTimeout,
  getClientIp, rateLimit, resetRateLimits, parseStripeSignature, computeStripeSignature,
};
