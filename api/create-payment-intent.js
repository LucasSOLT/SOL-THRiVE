// Creates a Stripe PaymentIntent. Price is fixed server-side so it can't be tampered with.
const { parseJsonBody, clampString, isValidEmail, fetchWithTimeout, rateLimit } = require('./_shared');

const AMOUNT_CENTS = 29700; // $297.00
const DESCRIPTION = '5 to THRiVE Practitioner Lab — Cohort Seat ($297.00)';
const STRIPE_TIMEOUT_MS = 8000;
const METADATA_MAX = 500; // Stripe's per-value metadata limit

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!rateLimit(req, res, { name: 'create-payment-intent', limit: 10 })) return;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return res.status(500).json({ error: 'Payments are not configured yet.' });

  let body;
  try {
    body = parseJsonBody(req);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }
  const lead = body.lead && typeof body.lead === 'object' ? body.lead : {};
  const booking = body.booking && typeof body.booking === 'object' ? body.booking : {};
  const clamp = (v) => clampString(v, METADATA_MAX);

  const params = new URLSearchParams({
    amount: String(AMOUNT_CENTS),
    currency: 'usd',
    'automatic_payment_methods[enabled]': 'true',
    description: DESCRIPTION,
    'metadata[first_name]': clamp(lead.fn),
    'metadata[last_name]': clamp(lead.ln),
    'metadata[organization]': clamp(lead.org),
    'metadata[email]': clamp(lead.em),
    'metadata[phone]': clamp(lead.ph),
    'metadata[session_date]': clamp(booking.date),
    'metadata[session_time]': clamp(booking.time),
  });
  // Only send receipt_email when it is well-formed; a malformed value makes Stripe reject the whole intent.
  const email = clampString(lead.em, 254).trim();
  if (isValidEmail(email)) params.set('receipt_email', email);

  try {
    const r = await fetchWithTimeout('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    }, STRIPE_TIMEOUT_MS);
    let j = {};
    try { j = await r.json(); } catch (_) { j = {}; }
    if (!r.ok) return res.status(502).json({ error: (j.error && j.error.message) || 'Stripe error' });
    if (!j.client_secret) return res.status(502).json({ error: 'Stripe returned no client secret' });
    res.status(200).json({ clientSecret: j.client_secret });
  } catch (e) {
    if (e && e.name === 'AbortError') return res.status(504).json({ error: 'Stripe timed out. Please try again.' });
    res.status(502).json({ error: 'Could not reach Stripe.' });
  }
};

module.exports.AMOUNT_CENTS = AMOUNT_CENTS;
module.exports.DESCRIPTION = DESCRIPTION;
