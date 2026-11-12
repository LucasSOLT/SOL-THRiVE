const { rateLimit } = require("./_shared");

const MAX_CONTENTS_CHARS = 32000;
const MAX_CONTENTS_ITEMS = 50;
const MAX_SYSTEM_INSTRUCTION_CHARS = 8000;
const MAX_TEXT_CHARS = 32000;
const UPSTREAM_TIMEOUT_MS = 6000;

const REVOKED_KEYS = new Set([
  "AIzaSyDhByu-gVi8PNLtDdl41ETxOmu2JOEVt8A",
  "sk_d2fc2ac281afdb8a56178f44c8ebca76f21da62f7a256bf8"
]);

function sanitizeKey(val) {
  const trimmed = String(val || "").trim();
  if (!trimmed || trimmed.includes("VITE_") || REVOKED_KEYS.has(trimmed)) {
    return "";
  }
  return trimmed;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  if (!rateLimit(req, res, { name: "gemini", limit: 20 })) return;

  let body = req.body;
  if (Buffer.isBuffer(body)) body = body.toString("utf8");
  if (typeof body === "string") {
    if (!body.trim()) {
      body = {};
    } else {
      try {
        body = JSON.parse(body);
      } catch (_) {
        res.status(400).json({ error: "Invalid JSON payload" });
        return;
      }
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) body = {};

  const headerKey = req.headers && req.headers["x-gemini-api-key"];
  const activeKey = sanitizeKey(
    headerKey ||
    process.env.GEMINI_API_KEY ||
    process.env.VITE_GEMINI_API_KEY ||
    ""
  );

  if (!activeKey) {
    res.status(503).json({ fallback: true, reason: "no_active_server_key" });
    return;
  }

  let payload = null;
  if (Array.isArray(body.contents)) {
    let contentsChars = 0;
    try {
      contentsChars = JSON.stringify(body.contents).length;
    } catch (_) {
      contentsChars = Infinity;
    }
    if (body.contents.length > MAX_CONTENTS_ITEMS || contentsChars > MAX_CONTENTS_CHARS) {
      res.status(413).json({ error: `Payload too large (max ${MAX_CONTENTS_CHARS} characters)` });
      return;
    }
    payload = { contents: body.contents };
    if (body.systemInstruction) {
      let sysChars = 0;
      try {
        sysChars = JSON.stringify(body.systemInstruction).length;
      } catch (_) {
        sysChars = Infinity;
      }
      if (sysChars > MAX_SYSTEM_INSTRUCTION_CHARS) {
        res.status(413).json({ error: "systemInstruction too large" });
        return;
      }
      payload.systemInstruction = body.systemInstruction;
    }
  } else {
    const rawText = String(body.text || body.prompt || "").trim();
    if (!rawText) {
      res.status(400).json({ error: "Missing text or contents in request body" });
      return;
    }
    if (rawText.length > MAX_TEXT_CHARS) {
      res.status(413).json({ error: `Payload too large (max ${MAX_TEXT_CHARS} characters)` });
      return;
    }
    const promptText = body.prompt
      ? String(body.prompt)
      : body.mode === "flow-problem"
        ? `Take this rambling problem description and clean it up into a single, clear, concise 2-3 sentence statement. Keep the user's original tone and meaning, but make it read professionally. Return ONLY the final cleaned statement. DO NOT provide options, introductory text, or conversational filler: "${rawText}"`
        : `Organize the following dictated text into clear bullet points. Remove conversational filler words and clean up the phrasing so it reads professionally and directly. Do NOT remove any core details or stories. Text:\n\n${rawText}`;

    payload = {
      contents: [{ parts: [{ text: promptText }] }]
    };
    if (body.systemInstruction) {
      payload.systemInstruction = typeof body.systemInstruction === "string"
        ? { parts: [{ text: body.systemInstruction }] }
        : body.systemInstruction;
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(activeKey)}`,
      {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }
    );
    clearTimeout(timeoutId);

    if (!upstream.ok) {
      res.status(upstream.status || 502).json({ fallback: true, reason: `upstream_http_${upstream.status}` });
      return;
    }

    const data = await upstream.json();
    const candidateText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    res.status(200).json({
      text: candidateText,
      candidates: data?.candidates || []
    });
  } catch (err) {
    clearTimeout(timeoutId);
    res.status(502).json({ fallback: true, reason: err?.name === "AbortError" ? "timeout" : "network_error" });
  }
};
