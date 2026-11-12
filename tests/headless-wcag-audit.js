#!/usr/bin/env node
/**
 * tests/headless-wcag-audit.js
 *
 * Batch 7 — WCAG 2.1 AA verification across all routes:
 *  - <a class="skip-to-content" href="#main-content"> + #main-content target on every page
 *  - assets/minds-eye-captions.vtt synced to public/assets and <track kind="captions"> on every video
 *  - contrast >= 4.5:1 on muted text, footer text, .day:disabled, input placeholders, tier tags, badges
 *  - :focus-visible outline and @media (prefers-reduced-motion: reduce) present in stylesheets
 * Skips headless checks gracefully (exit 0) when no Chrome/Chromium is available.
 */
const fs = require('fs');
const path = require('path');
const { startServer, findChrome, launchChrome, openPage, listRoutes } = require('./headless-viewport-audit.js');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

const PUBLIC = path.join(__dirname, '..', 'public');
const PAGES = ['index', 'classes', 'onboarding', 'how-to-use', 'approach', 'rebuilding-life-challenges', 'employment-challenges', 'funnel', 'mockup-landing', 'landingpage', 'results', 'survey', 'profile', 'hope-survey', '404'];

function lum([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(a, b) { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }

async function main() {
  console.log('Static skip-link, main-content, and captions checks');
  const vttRoot = path.join(__dirname, '..', 'assets', 'minds-eye-captions.vtt');
  const vttPub = path.join(PUBLIC, 'assets', 'minds-eye-captions.vtt');
  check('assets/minds-eye-captions.vtt exists in root and public/assets', fs.existsSync(vttRoot) && fs.existsSync(vttPub));
  const vttText = fs.readFileSync(vttPub, 'utf8');
  check('VTT starts with WEBVTT header and contains cues', /^WEBVTT/.test(vttText) && /-->/.test(vttText));
  const buildPy = fs.readFileSync(path.join(__dirname, '..', 'build.py'), 'utf8');
  check('build.py copies all non-excluded assets (including .vtt)', /os\.listdir\(assets_src\)/.test(buildPy) && !/minds-eye-captions\.vtt/.test((buildPy.match(/excluded_assets\s*=\s*\{[\s\S]*?\}/)||[''])[0]));

  for (const p of PAGES) {
    const html = fs.readFileSync(path.join(PUBLIC, p + '.html'), 'utf8');
    check(`public/${p}: skip-to-content link present`, /<a[^>]+class="[^"]*skip-to-content[^"]*"[^>]+href="#main-content"/.test(html));
    check(`public/${p}: id="main-content" target present`, /id="main-content"/.test(html));
  }
  for (const p of ['index', 'funnel', 'mockup-landing', 'results']) {
    const html = fs.readFileSync(path.join(PUBLIC, p + '.html'), 'utf8');
    const videos = (html.match(/<video\b[\s\S]*?<\/video>/g) || []);
    check(`public/${p}: all ${videos.length} <video> elements include <track kind="captions">`, videos.length > 0 && videos.every(v => /<track[^>]+kind="captions"[^>]+minds-eye-captions\.vtt/.test(v)));
  }

  console.log('Contrast math checks');
  check('--text-muted (#4B5563) on cream (#F7F4EB) >= 4.5:1', ratio([75, 85, 99], [247, 244, 235]) >= 4.5);
  check('.day:disabled (#6E6A60) on white (#FFFFFF) >= 4.5:1', ratio([110, 106, 96], [255, 255, 255]) >= 4.5);
  check('funnel placeholder (#52525B) on cream (#F9F6F0) >= 4.5:1', ratio([82, 82, 91], [249, 246, 240]) >= 4.5);
  check('footer copyright (#9CA3AF) on dark (#141824) >= 4.5:1', ratio([156, 163, 175], [20, 24, 36]) >= 4.5);
  check('section-eyebrow (#BE123C) on pink (#FFE4E6) >= 4.5:1', ratio([190, 18, 60], [255, 228, 230]) >= 4.5);
  check('tier-tag t1 (#0360D0) with white >= 4.5:1', ratio([3, 96, 208], [255, 255, 255]) >= 4.5);
  check('tier-tag t3 (#92400E) with white >= 4.5:1', ratio([146, 64, 14], [255, 255, 255]) >= 4.5);
  check('check-icon / flow badge (#047857) on white >= 4.5:1', ratio([4, 120, 87], [255, 255, 255]) >= 4.5);
  check('results #share-fb (#46638F) with white >= 4.5:1', ratio([70, 99, 143], [255, 255, 255]) >= 4.5);
  check('results #vote-prompt-hint (#855800) on white >= 4.5:1', ratio([133, 88, 0], [255, 255, 255]) >= 4.5);

  const chrome = findChrome();
  if (!chrome || typeof WebSocket === 'undefined') { console.log(`\nWCAG audit (static): ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const { cdp, cleanup } = await launchChrome(chrome);
  try {
    console.log('Headless skip-link, focus-visible, and reduced-motion checks');
    for (const route of ['index', 'onboarding', 'how-to-use', 'funnel', 'results', 'survey']) {
      const page = await openPage(cdp, base, route, 1280, 800);
      const r = await page.evaluate(`(() => {
        const skip = document.querySelector('a.skip-to-content');
        const main = document.getElementById('main-content');
        if (!skip || !main) return { ok: false };
        const offTop = skip.getBoundingClientRect().top;
        skip.focus();
        const focusedTop = skip.getBoundingClientRect().top;
        let hasFocusRule = false; let hasMotionRule = false;
        for (const s of Array.from(document.styleSheets)) {
          try {
            for (const rule of Array.from(s.cssRules)) {
              if (rule.selectorText && /focus-visible/.test(rule.selectorText)) hasFocusRule = true;
              if (rule.type === CSSRule.MEDIA_RULE && /prefers-reduced-motion/.test(rule.conditionText || rule.media.mediaText)) hasMotionRule = true;
            }
          } catch (_) {}
        }
        return { ok: true, offTop, focusedTop, hasFocusRule, hasMotionRule };
      })()`);
      check(`/${route}: skip link hidden off-screen and revealed on focus`, r.ok && r.offTop < 0 && r.focusedTop >= 0, JSON.stringify(r));
      check(`/${route}: :focus-visible + prefers-reduced-motion rules loaded`, r.hasFocusRule && r.hasMotionRule, JSON.stringify(r));
      await page.close();
    }
  } finally { cleanup(); server.close(); }
  console.log(`\nWCAG audit: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
