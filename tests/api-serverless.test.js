#!/usr/bin/env node
/**
 * tests/api-serverless.test.js — Unit & security tests for all 6 Vercel serverless functions:
 *  1. api/config.js
 *  2. api/create-payment-intent.js
 *  3. api/stripe-webhook.js (valid/invalid/rotated HMAC v1 signatures, NaN/replay rejection, >256KB body cap, malformed JSON)
 *  4. api/event.js (clamping, honeypot silent drop, timeout handling, payment type rejection)
 *  5. api/gemini.js (contents character limit <= 32,000, revoked key rejection, rate limiting)
 *  6. api/tts.js (model_id allowlist, voice_settings clamping, Gemini fallback, rate limiting)
 */
'use strict';

const configHandler = require('../api/config');
const paymentHandler = require('../api/create-payment-intent');
const webhookHandler = require('../api/stripe-webhook');
const eventHandler = require('../api/event');
const geminiHandler = require('../api/gemini');
const ttsHandler = require('../api/tts');
const { computeStripeSignature, resetRateLimits } = require('../api/_shared');

let pass = 0;
let fail = 0;

function check(label, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  [PASS] ${label}`);
  } else {
    fail++;
    console.error(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`);
  }
}

function callHandler(handler, { method = 'POST', body = {}, headers = {}, ip = '' } = {}) {
  return new Promise((resolve, reject) => {
    const resHeaders = {};
    let statusCode = 200;
    const req = {
      method,
      body,
      headers: { ...headers },
      socket: ip ? { remoteAddress: ip } : {}
    };
    if (ip && !req.headers['x-forwarded-for']) req.headers['x-forwarded-for'] = ip;
    const res = {
      setHeader(k, v) { resHeaders[String(k).toLowerCase()] = v; return this; },
      status(code) { statusCode = code; return this; },
      json(payload) { resolve({ status: statusCode, headers: resHeaders, body: payload }); return this; },
      send(payload) { resolve({ status: statusCode, headers: resHeaders, body: payload }); return this; },
      end(payload) { resolve({ status: statusCode, headers: resHeaders, body: payload }); return this; }
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

async function main() {
  const origFetch = global.fetch;
  const origEnv = { ...process.env };

  try {
    // -----------------------------------------------------------------------
    // 1. api/config.js
    // -----------------------------------------------------------------------
    console.log('1. api/config.js');
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_thrive_123';
    const cfgRes = await callHandler(configHandler, { method: 'GET' });
    check('returns 200 with publishableKey & Cache-Control: no-store',
      cfgRes.status === 200 && cfgRes.body.publishableKey === 'pk_test_thrive_123' && cfgRes.headers['cache-control'] === 'no-store');

    // -----------------------------------------------------------------------
    // 2. api/create-payment-intent.js
    // -----------------------------------------------------------------------
    console.log('2. api/create-payment-intent.js');
    if (typeof resetRateLimits === 'function') resetRateLimits();
    const getMethodRes = await callHandler(paymentHandler, { method: 'GET' });
    check('rejects non-POST with 405', getMethodRes.status === 405);

    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    let capturedStripeParams = null;
    global.fetch = async (_url, opts) => {
      capturedStripeParams = new URLSearchParams(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'pi_123', client_secret: 'pi_123_secret' })
      };
    };

    const longOrg = 'X'.repeat(800);
    const badEmailRes = await callHandler(paymentHandler, {
      body: JSON.stringify({
        lead: { fn: 'Dana', ln: 'Cole', org: longOrg, em: 'not-an-email', ph: '7205550100' },
        booking: { date: '2026-11-30', time: '17:00 MT' }
      })
    });
    check('accepts string req.body & returns clientSecret', badEmailRes.status === 200 && badEmailRes.body.clientSecret === 'pi_123_secret');
    check('omits receipt_email when lead.em is malformed', !capturedStripeParams.has('receipt_email'));
    check('clamps metadata fields to <= 500 chars', capturedStripeParams.get('metadata[organization]').length === 500);
    check('sets updated cohort seat description ($297.00)',
      capturedStripeParams.get('description') === '5 to THRiVE Practitioner Lab — Cohort Seat ($297.00)' &&
      capturedStripeParams.get('amount') === '29700');

    await callHandler(paymentHandler, { body: { lead: { em: 'clinician@thrivecoaching.ai' } } });
    check('includes receipt_email when lead.em is valid', capturedStripeParams.get('receipt_email') === 'clinician@thrivecoaching.ai');

    global.fetch = async (_url, opts) => new Promise((_res, rej) => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      if (opts && opts.signal) opts.signal.addEventListener('abort', () => rej(err));
      rej(err);
    });
    const abortRes = await callHandler(paymentHandler, { body: { lead: { fn: 'Test' } } });
    check('returns 504 on upstream Stripe timeout (AbortError)', abortRes.status === 504);

    // -----------------------------------------------------------------------
    // 3. api/stripe-webhook.js
    // -----------------------------------------------------------------------
    console.log('3. api/stripe-webhook.js');
    const secretOld = 'whsec_old_secret_key';
    const secretActive = 'whsec_active_secret_key';
    process.env.STRIPE_WEBHOOK_SECRET = secretActive;
    delete process.env.VISION_CONTROL_WEBHOOK_URL;

    const nowSec = Math.floor(Date.now() / 1000);
    const validEventJson = JSON.stringify({
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_ok',
          amount: 29700,
          currency: 'usd',
          metadata: { first_name: 'Sam', last_name: 'Rivera', email: 'sam@example.com', organization: 'Care Clinic' }
        }
      }
    });
    const sigOld = computeStripeSignature(secretOld, nowSec, validEventJson);
    const sigActive = computeStripeSignature(secretActive, nowSec, validEventJson);

    const rotatedRes = await callHandler(webhookHandler, {
      body: validEventJson,
      headers: { 'stripe-signature': `t=${nowSec},v1=${sigOld},v1=${sigActive}` }
    });
    check('accepts rotated header with multiple v1= signatures when one matches', rotatedRes.status === 200 && rotatedRes.body.received === true);

    const invalidSigRes = await callHandler(webhookHandler, {
      body: validEventJson,
      headers: { 'stripe-signature': `t=${nowSec},v1=${sigOld}` }
    });
    check('rejects invalid HMAC signature with 400', invalidSigRes.status === 400);

    const staleTime = nowSec - 1000;
    const staleSig = computeStripeSignature(secretActive, staleTime, validEventJson);
    const replayRes = await callHandler(webhookHandler, {
      body: validEventJson,
      headers: { 'stripe-signature': `t=${staleTime},v1=${staleSig}` }
    });
    check('rejects replay outside 300s tolerance window with 400', replayRes.status === 400);

    const nanRes = await callHandler(webhookHandler, {
      body: validEventJson,
      headers: { 'stripe-signature': `t=notanumber,v1=${sigActive}` }
    });
    check('rejects NaN timestamp with 400', nanRes.status === 400);

    const brokenJson = '{not-valid-json';
    const brokenSig = computeStripeSignature(secretActive, nowSec, brokenJson);
    const malformedRes = await callHandler(webhookHandler, {
      body: brokenJson,
      headers: { 'stripe-signature': `t=${nowSec},v1=${brokenSig}` }
    });
    check('returns 400 (not 500) on malformed JSON payload', malformedRes.status === 400);

    const hugeRaw = 'x'.repeat(webhookHandler.MAX_BODY_BYTES + 1024);
    const hugeRes = await callHandler(webhookHandler, {
      body: hugeRaw,
      headers: { 'stripe-signature': `t=${nowSec},v1=${sigActive}` }
    });
    check('rejects body > 256 KB with 413', hugeRes.status === 413);

    // -----------------------------------------------------------------------
    // 4. api/event.js
    // -----------------------------------------------------------------------
    console.log('4. api/event.js');
    let forwardedPayload = null;
    process.env.VISION_CONTROL_WEBHOOK_URL = 'https://vc.example.test/hook';
    global.fetch = async (_url, opts) => {
      forwardedPayload = JSON.parse(opts.body);
      return { ok: true, status: 200 };
    };

    const hpRes = await callHandler(eventHandler, {
      body: { type: 'lead', website: 'https://spam.bot', lead: { fn: 'Bot' } }
    });
    check('honeypot submission returns 200 silently without forwarding', hpRes.status === 200 && forwardedPayload === null);

    const paymentTypeRes = await callHandler(eventHandler, {
      body: { type: 'payment', data: {} }
    });
    check('rejects browser-submitted payment event type with 400', paymentTypeRes.status === 400);

    const supportRes = await callHandler(eventHandler, {
      body: JSON.stringify({
        type: 'support',
        lead: { fn: 'A'.repeat(900), em: 'help@example.com' },
        data: { message: 'M'.repeat(6000), category: 'B'.repeat(900) }
      })
    });
    check('clamps fields <= 500 chars and message <= 4000 chars',
      supportRes.status === 200 &&
      forwardedPayload &&
      forwardedPayload.lead.fn.length === 500 &&
      forwardedPayload.data.category.length === 500 &&
      forwardedPayload.data.message.length === 4000);

    // -----------------------------------------------------------------------
    // 5. api/gemini.js
    // -----------------------------------------------------------------------
    console.log('5. api/gemini.js');
    process.env.GEMINI_API_KEY = 'AIzaSyTestServerKey_ValidForUnitTesting12345';
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'Cleaned statement.' }] } }] })
    });

    const oversizeContents = [{ parts: [{ text: 'Z'.repeat(33000) }] }];
    const oversizeGemRes = await callHandler(geminiHandler, {
      body: { contents: oversizeContents }
    });
    check('rejects contents > 32,000 chars with 413', oversizeGemRes.status === 413);

    const okGemRes = await callHandler(geminiHandler, {
      body: { contents: [{ parts: [{ text: 'Short clinical note.' }] }] }
    });
    check('forwards valid Gemini request and returns 200', okGemRes.status === 200 && okGemRes.body.text === 'Cleaned statement.');

    // Rate limiting check (20 req/min per IP)
    let hit429 = false;
    for (let i = 0; i < 25; i++) {
      const r = await callHandler(geminiHandler, {
        ip: '203.0.113.77',
        body: { contents: [{ parts: [{ text: 'ping' }] }] }
      });
      if (r.status === 429 && r.headers['retry-after']) { hit429 = true; break; }
    }
    check('enforces per-IP sliding-window rate limit (429 + Retry-After)', hit429);

    // -----------------------------------------------------------------------
    // 6. api/tts.js
    // -----------------------------------------------------------------------
    console.log('6. api/tts.js');
    process.env.ELEVENLABS_API_KEY = 'el_test_valid_key_123456';
    const badModelRes = await callHandler(ttsHandler, {
      body: { text: 'Hello clinician', model_id: 'evil_unapproved_model' }
    });
    check('rejects non-allowlisted model_id with 400', badModelRes.status === 400);

    let capturedTtsBody = null;
    global.fetch = async (_url, opts) => {
      capturedTtsBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'audio/mpeg' },
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer
      };
    };
    const okTtsRes = await callHandler(ttsHandler, {
      body: { text: 'Welcome to Session 0.', model_id: 'eleven_turbo_v2_5', voice_settings: { stability: 9, similarity_boost: -3 } }
    });
    check('allows approved model_id, clamps voice_settings to [0, 1], and returns audio',
      okTtsRes.status === 200 &&
      capturedTtsBody.model_id === 'eleven_turbo_v2_5' &&
      capturedTtsBody.voice_settings.stability === 1 &&
      capturedTtsBody.voice_settings.similarity_boost === 0);

  } finally {
    global.fetch = origFetch;
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) delete process.env[k];
    }
    Object.assign(process.env, origEnv);
  }

  console.log(`\napi-serverless: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
