#!/usr/bin/env node
/**
 * scripts/verify-site.js — Zero-dependency static site & build verifier.
 *
 * Checks:
 *  (1) JS syntax (vm.Script) for script.js, storage-safe.js, build.js, api/*.js, and every inline <script> in public/*.html
 *      (and JSON.parse for <script type="application/ld+json">).
 *  (2) No broken internal href/src or #anchor targets across public/*.html.
 *  (3) No leaked API keys, no raw %VITE_% tokens in public/, no @babel/standalone or cdn.tailwindcss.com,
 *      and no fairytale banned terms (Cinderella, Harry Potter, Fairy Godmother, Magic Wand, "Go Unstuck Yourself", three-archetypes.jpg).
 *  (4) funnel.html vs mockup-landing.html lockstep parity (only line 21 og:url/canonical differs) and root -> public build sync.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');

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

// ---------------------------------------------------------------------------
// 1. JS Syntax (vm.Script) & JSON-LD
// ---------------------------------------------------------------------------
console.log('1. JavaScript & JSON-LD syntax');
const jsFiles = [
  'script.js',
  'storage-safe.js',
  'build.js',
  ...fs.readdirSync(path.join(ROOT, 'api')).filter(f => f.endsWith('.js')).map(f => path.join('api', f))
];

for (const rel of jsFiles) {
  const full = path.join(ROOT, rel);
  try {
    const code = fs.readFileSync(full, 'utf8');
    new vm.Script(code, { filename: rel });
    check(`${rel}: valid JS syntax`, true);
  } catch (err) {
    check(`${rel}: valid JS syntax`, false, err.message);
  }
}

const pubHtmlFiles = fs.readdirSync(PUB).filter(f => f.endsWith('.html')).sort();
for (const htmlFile of pubHtmlFiles) {
  const html = fs.readFileSync(path.join(PUB, htmlFile), 'utf8');
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  let idx = 0;
  let allOk = true;
  let errDetail = '';
  while ((m = scriptRe.exec(html)) !== null) {
    const attrs = m[1] || '';
    const body = m[2] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    idx++;
    if (/application\/ld\+json/i.test(attrs)) {
      try {
        JSON.parse(body);
      } catch (err) {
        allOk = false;
        errDetail = `JSON-LD #${idx}: ${err.message}`;
      }
      continue;
    }
    try {
      const parseTarget = /\btype\s*=\s*["']module["']/i.test(attrs)
        ? body.replace(/^\s*import\s+[\s\S]*?from\s+["'][^"']+["']\s*;?/gm, '// import')
        : body;
      new vm.Script(parseTarget, { filename: `public/${htmlFile}#inline-${idx}` });
    } catch (err) {
      allOk = false;
      errDetail = `inline #${idx}: ${err.message}`;
    }
  }
  check(`public/${htmlFile}: all ${idx} inline script block(s) parse cleanly`, allOk, errDetail);
}

// ---------------------------------------------------------------------------
// 2. Internal href / src & #anchor target resolution across public/*.html
// ---------------------------------------------------------------------------
console.log('2. Internal links, asset references & #anchor targets');

function collectIds(html) {
  const ids = new Set();
  const re = /\b(?:id|name)\s*=\s*"([^"]+)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  return ids;
}

const idMap = new Map();
for (const f of pubHtmlFiles) {
  idMap.set(f, collectIds(fs.readFileSync(path.join(PUB, f), 'utf8')));
}

function resolvePublicFile(refPath) {
  const clean = refPath.replace(/^\/+/, '');
  if (!clean) return 'index.html';
  const direct = path.join(PUB, clean);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return clean;
  const withHtml = clean + '.html';
  if (fs.existsSync(path.join(PUB, withHtml))) return withHtml;
  return null;
}

for (const htmlFile of pubHtmlFiles) {
  const html = fs.readFileSync(path.join(PUB, htmlFile), 'utf8');
  // Strip <script> and <style> blocks before scanning HTML attributes
  const markupOnly = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '');

  const attrRe = /\b(href|src|poster)\s*=\s*"([^"]*)"/gi;
  const broken = [];
  let m;
  while ((m = attrRe.exec(markupOnly)) !== null) {
    const attr = m[1].toLowerCase();
    const raw = m[2].trim();
    if (!raw) continue;
    if (/^(https?:|mailto:|tel:|data:|javascript:|blob:)/i.test(raw)) continue;

    const [pathPart, hashPart] = raw.split('#');
    const cleanPath = (pathPart || '').split('?')[0];

    let targetFile = htmlFile;
    if (cleanPath) {
      const resolved = resolvePublicFile(cleanPath);
      if (!resolved) {
        broken.push(`${attr}="${raw}" (missing file)`);
        continue;
      }
      targetFile = resolved;
    }

    if (hashPart && attr === 'href' && targetFile.endsWith('.html')) {
      const ids = idMap.get(targetFile);
      if (ids && !ids.has(hashPart)) {
        broken.push(`href="${raw}" (missing #${hashPart} in ${targetFile})`);
      }
    }
  }
  check(`public/${htmlFile}: zero broken internal links/assets/anchors`, broken.length === 0, broken.slice(0, 5).join('; '));
}

// ---------------------------------------------------------------------------
// 3. Security, Zero Runtime Transpilers & Zero Fairytale Regressions
// ---------------------------------------------------------------------------
console.log('3. Security, transpiler & fairytale regression checks');

const KNOWN_PUBLIC_OR_REVOKED_TOKENS = new Set([
  'AIzaSyDhByu-gVi8PNLtDdl41ETxOmu2JOEVt8A', // revoked key blocklist entry
  'sk_d2fc2ac281afdb8a56178f44c8ebca76f21da62f7a256bf8', // revoked key blocklist entry
  'AIzaSyDL5rSRy4P0PGK3xoq7hJu43xs14jZTuM8' // public Firebase web app config
]);
const SECRET_PATTERNS = [
  /AIzaSy[A-Za-z0-9_-]{30,}/g,
  /sk_live_[A-Za-z0-9]{20,}/g,
  /rk_live_[A-Za-z0-9]{20,}/g,
  /whsec_[A-Za-z0-9]{20,}/g,
  /sk_[a-f0-9]{40,}/gi
];
const TRANSPILER_PATTERNS = [
  /@babel\/standalone/i,
  /<script[^>]+type\s*=\s*["']text\/babel["']/i,
  /cdn\.tailwindcss\.com/i
];
const FAIRYTALE_PATTERNS = [
  /\bcinderella\b/i,
  /\bharry\s+potter\b/i,
  /\bfairy\s+godmother\b/i,
  /\bmagic\s+wand\b/i,
  /go\s+unstuck\s+yourself/i,
  /three-archetypes\.jpg/i
];

for (const htmlFile of pubHtmlFiles) {
  const html = fs.readFileSync(path.join(PUB, htmlFile), 'utf8');
  const hasViteToken = /%VITE_[A-Z0-9_]+%/.test(html);
  const hasSecret = SECRET_PATTERNS.some(r => (html.match(r) || []).some(tok => !KNOWN_PUBLIC_OR_REVOKED_TOKENS.has(tok)));
  const hasTranspiler = TRANSPILER_PATTERNS.some(r => r.test(html));
  const hasFairytale = FAIRYTALE_PATTERNS.some(r => r.test(html));
  check(`public/${htmlFile}: no raw %VITE_% tokens or leaked keys`, !hasViteToken && !hasSecret);
  check(`public/${htmlFile}: no runtime Babel/Tailwind CDN & no fairytale terms`, !hasTranspiler && !hasFairytale);
}

for (const rootTokenFile of ['profile.html', 'survey.html', 'hope-survey.html']) {
  const raw = fs.readFileSync(path.join(ROOT, rootTokenFile), 'utf8');
  check(`${rootTokenFile}: preserves %VITE_GEMINI_API_KEY% & %VITE_ELEVENLABS_API_KEY% placeholders in root`,
    raw.includes('%VITE_GEMINI_API_KEY%') && raw.includes('%VITE_ELEVENLABS_API_KEY%'));
}

// ---------------------------------------------------------------------------
// 4. funnel.html <-> mockup-landing.html Parity & Root -> public/ Build Sync
// ---------------------------------------------------------------------------
console.log('4. Funnel parity & root -> public build sync');

const funnelLines = fs.readFileSync(path.join(ROOT, 'funnel.html'), 'utf8').split('\n');
const mockupLines = fs.readFileSync(path.join(ROOT, 'mockup-landing.html'), 'utf8').split('\n');
const diffLines = [];
const maxLen = Math.max(funnelLines.length, mockupLines.length);
for (let i = 0; i < maxLen; i++) {
  if (funnelLines[i] !== mockupLines[i]) diffLines.push(i + 1);
}
check('funnel.html vs mockup-landing.html differ only on line 21 (og:url/canonical)',
  funnelLines.length === mockupLines.length && diffLines.length === 1 && diffLines[0] === 21,
  `diff lines: ${diffLines.join(', ')}`);

const SYNC_FILES = [
  'index.html', 'classes.html', 'onboarding.html', '404.html',
  'mockup-landing.html', 'funnel.html', 'results.html', ' approach.html'.trim(),
  'how-to-use.html', 'rebuilding-life-challenges.html', 'employment-challenges.html',
  'style.css', 'tailwind.css', 'script.js', 'storage-safe.js',
  'manifest.webmanifest', 'sitemap.xml', 'robots.txt'
];
for (const f of SYNC_FILES) {
  const r = fs.readFileSync(path.join(ROOT, f));
  const p = fs.readFileSync(path.join(PUB, f));
  check(`public/${f} matches root ${f}`, r.equals(p));
}
check('public/landingpage.html matches root funnel.html',
  fs.readFileSync(path.join(ROOT, 'funnel.html')).equals(fs.readFileSync(path.join(PUB, 'landingpage.html'))));

for (const tokenFile of ['profile.html', 'survey.html', 'hope-survey.html']) {
  const expected = fs.readFileSync(path.join(ROOT, tokenFile), 'utf8')
    .replace(/%VITE_ELEVENLABS_API_KEY%/g, '')
    .replace(/%VITE_GEMINI_API_KEY%/g, '');
  const actual = fs.readFileSync(path.join(PUB, tokenFile), 'utf8');
  check(`public/${tokenFile} matches sanitized root ${tokenFile}`, expected === actual);
}

console.log(`\nverify-site: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
