// Forwards funnel events (lead, vote, booking, support) to Vision Control.
// Vision Control's real API/webhook format isn't confirmed yet: adjust `forward()` below once known.
const {
  parseJsonBody, clampString, sanitizeDeep, hasHoneypot, fetchWithTimeout, rateLimit,
} = require('./_shared');

const FORWARD_TIMEOUT_MS = 6000;
const FIELD_MAX = 500;
const MESSAGE_MAX = 4000;
const ALLOWED_TYPES = ['lead', 'vote', 'booking', 'support'];

async function forward(payload) {
  const url = process.env.VISION_CONTROL_WEBHOOK_URL;
  if (!url) {
    console.log('[funnel-event]', JSON.stringify(payload)); // fallback: visible in Vercel logs
    return;
  }
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.VISION_CONTROL_API_KEY) headers.Authorization = `Bearer ${process.env.VISION_CONTROL_API_KEY}`;
  const r = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(payload) }, FORWARD_TIMEOUT_MS);
  if (!r.ok) throw new Error(`Vision Control responded ${r.status}`);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!rateLimit(req, res, { name: 'event', limit: 30 })) return;

  let body;
  try {
    body = parseJsonBody(req);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }

  const type = clampString(body.type, 32);
  if (!ALLOWED_TYPES.includes(type)) return res.status(400).json({ error: 'Bad event type' });
  // 'payment' is intentionally NOT accepted from the browser; see stripe-webhook.js

  // Honeypot: bots fill hidden fields. Acknowledge with 200 so they do not retry, but forward nothing.
  if (hasHoneypot(body, body.data, body.lead)) return res.status(200).json({ ok: true });

  try {
    const cleanOpts = { maxString: FIELD_MAX, longKeys: { message: MESSAGE_MAX } };
    const data = sanitizeDeep(body.data && typeof body.data === 'object' ? body.data : {}, cleanOpts) || {};
    const l = sanitizeDeep(body.lead && typeof body.lead === 'object' ? body.lead : {}, cleanOpts) || {};
    const ts = clampString(body.ts, 64);
    const r = Array.isArray(data.ratings) ? data.ratings : [];
    const rating = (i) => (r[i] === undefined || r[i] === null ? '' : r[i]);
    const str = (v, max = FIELD_MAX) => clampString(v, max);

    await forward({
      source: 'thrive-funnel', type, ts,
      first_name: str(l.fn),
      last_name: str(l.ln),
      firstName: str(l.fn),
      lastName: str(l.ln),
      name: [str(l.fn), str(l.ln)].filter(Boolean).join(' '),
      companyName: str(l.org),
      full_name: [str(l.fn), str(l.ln)].filter(Boolean).join(' '),
      company_name: str(l.org),
      email: str(l.em),
      phone: str(l.ph),
      rating_between_session_engagement: rating(0),
      rating_client_ai_reality: rating(1),
      rating_ethical_ai_copilot: rating(2),
      vote: str(data.vote),
      booking_label: str(data.label),
      support_category: str(data.category),
      support_urgency: str(data.urgency),
      support_squad: str(data.squad),
      message: str(data.message, MESSAGE_MAX),
      data, lead: l,
    });
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'Forwarding failed' });
  }
};

module.exports.forward = forward;
