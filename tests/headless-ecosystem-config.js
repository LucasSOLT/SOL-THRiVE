#!/usr/bin/env node
/**
 * tests/headless-ecosystem-config.js
 *
 * Verifies THRIVE_ECOSYSTEM_CONFIG progressive enhancement in real headless Chrome:
 *  - "Practitioner Hub" + "Classroom Login ↗" exist in header, mobile drawer and footer of every guide/marketing page
 *  - data-lw-link anchors fall back to the school URL when specific URLs are unset
 *  - changing ONE config value updates every matching link; YouTube IDs swap in/out embeds cleanly
 *  - the header never overflows: hamburger drawer below 1360px, single-row compact nav above
 * Skips gracefully (exit 0) when no Chrome/Chromium is available.
 */
const { startServer, findChrome, launchChrome, openPage } = require('./headless-viewport-audit.js');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

const PAGES = ['index', 'classes', 'approach', 'how-to-use', 'onboarding', 'rebuilding-life-challenges', 'employment-challenges', '404', 'survey', 'profile', 'hope-survey'];
const SCHOOL = 'https://thrive-coaching.learnworlds.com';

async function main() {
  const chrome = findChrome();
  if (!chrome || typeof WebSocket === 'undefined') { console.log('Ecosystem config test skipped: no headless Chrome available.'); process.exit(0); }
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const { cdp, cleanup } = await launchChrome(chrome);
  try {
    console.log('Access paths in header / drawer / footer');
    for (const route of PAGES) {
      const page = await openPage(cdp, base, route, 1280, 800);
      const r = await page.evaluate(`(() => {
        const q = (sel) => Array.from(document.querySelectorAll(sel));
        const login = (root) => q(root + ' a.classroom-login-link[data-lw-link="login"]').length;
        const hub = (root) => q(root + ' a[href$="onboarding.html"]').filter(a => /Practitioner Hub/.test(a.textContent)).length;
        const h = document.querySelector('.header');
        const dm = document.querySelector('.desktop-menu');
        return { dLogin: login('.desktop-menu'), dHub: hub('.desktop-menu'), mLogin: login('.mobile-drawer'), mHub: hub('.mobile-drawer'), fLogin: login('.footer-nav'), fHub: hub('.footer-nav'),
          loginHref: (q('a.classroom-login-link')[0] || {}).href, loginTarget: (q('a.classroom-login-link')[0] || {}).target,
          loginRel: (q('a.classroom-login-link')[0] || {}).rel, hasCfg: typeof window.THRIVE_ECOSYSTEM_CONFIG === 'object' };
      })()`);
      check(`/${route}: Practitioner Hub + Classroom Login in header`, r.dLogin >= 1 && r.dHub >= 1, JSON.stringify(r));
      check(`/${route}: ... in mobile drawer`, r.mLogin >= 1 && r.mHub >= 1);
      check(`/${route}: ... in footer`, r.fLogin >= 1 && r.fHub >= 1);
      check(`/${route}: login link opens school in new tab safely`, r.loginHref && r.loginHref.replace(/\/$/, '') === SCHOOL && r.loginTarget === '_blank' && /noopener/.test(r.loginRel));
      check(`/${route}: THRIVE_ECOSYSTEM_CONFIG exposed`, r.hasCfg);
      await page.close();
    }

    console.log('Config-driven links & video slots (index)');
    let page = await openPage(cdp, base, 'index', 1280, 800);
    const before = await page.evaluate(`(() => ({
      steakEmbeds: document.querySelectorAll('[data-video-slot="steak"] iframe.video-slot-iframe').length,
      sizzleSlots: document.querySelectorAll('[data-video-slot^="sizzle"]').length,
      sizzleVideos: document.querySelectorAll('[data-video-slot^="sizzle"] video').length
    }))()`);
    check('no embeds when YouTube IDs unset (fallback players intact)', before.steakEmbeds === 0 && before.sizzleSlots === 3 && before.sizzleVideos === 3, JSON.stringify(before));
    const after = await page.evaluate(`(() => {
      const c = window.THRIVE_ECOSYSTEM_CONFIG;
      c.video.steakVideoYoutubeId = 'https://youtu.be/dQw4w9WgXcQ';
      c.video.sizzle30YoutubeId = 'abcdefghijk';
      c.learnworlds.login = 'https://classroom.example.org/login';
      const res = window.applyThriveEcosystemConfig();
      const steak = document.querySelector('[data-video-slot="steak"] iframe.video-slot-iframe');
      const s30 = document.querySelector('[data-video-slot="sizzle30"] iframe.video-slot-iframe');
      const out = {
        res,
        steakSrc: steak && steak.src, s30Src: s30 && s30.src,
        steakClass: document.querySelector('[data-video-slot="steak"]').classList.contains('has-embed'),
        videoHidden: getComputedStyle(document.querySelector('[data-video-slot="sizzle30"] video')).display,
        badgeVisible: getComputedStyle(document.querySelector('[data-video-slot="sizzle30"] .sizzle-duration-badge')).display,
        s60Embeds: document.querySelectorAll('[data-video-slot="sizzle60"] iframe').length,
        logins: Array.from(document.querySelectorAll('a[data-lw-link="login"]')).map(a => a.href)
      };
      // invalid values must be ignored (non-https URL / bad ID)
      c.video.sizzle60YoutubeId = 'not an id';
      c.learnworlds.squadA = 'javascript:alert(1)';
      window.applyThriveEcosystemConfig();
      out.badIdEmbeds = document.querySelectorAll('[data-video-slot="sizzle60"] iframe').length;
      out.badUrl = window.resolveThriveEcosystemLink('squadA');
      // clearing restores the fallback
      c.video.steakVideoYoutubeId = '';
      window.applyThriveEcosystemConfig();
      out.restored = document.querySelectorAll('[data-video-slot="steak"] iframe').length === 0 && !document.querySelector('[data-video-slot="steak"]').classList.contains('has-embed');
      return out;
    })()`);
    check('steak YouTube URL/ID is normalised into a nocookie embed', /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/.test(after.steakSrc || '') && after.steakClass, JSON.stringify(after));
    check('sizzle30 embed injected and fallback <video> hidden', /embed\/abcdefghijk/.test(after.s30Src || '') && after.videoHidden === 'none');
    check('duration badge stays visible over embed', after.badgeVisible !== 'none');
    check('untouched slots keep fallback', after.s60Embeds === 0);
    check('one config line updates every login link', after.logins.length >= 3 && after.logins.every((h) => h.startsWith('https://classroom.example.org/login')), after.logins.join(','));
    check('invalid YouTube ID is rejected', after.badIdEmbeds === 0);
    check('non-https URLs are rejected (falls back to school)', after.badUrl.replace(/\/$/, '') === SCHOOL, after.badUrl);
    check('clearing the ID restores fallback markup', after.restored);
    check('no page errors on index', page.issues.length === 0, page.issues.join(' | '));
    await page.close();

    console.log('Squad / Review Center / Personos hooks (how-to-use)');
    page = await openPage(cdp, base, 'how-to-use', 1280, 800);
    const h = await page.evaluate(`(() => {
      const pers = document.querySelector('[data-lw-link="personos"]');
      const rev = document.querySelector('[data-lw-link="reviewCenter"]');
      const out = { persHiddenDefault: !!pers && pers.hasAttribute('hidden'), revDefault: rev && rev.href };
      const c = window.THRIVE_ECOSYSTEM_CONFIG;
      c.learnworlds.reviewCenter = 'https://thrive-coaching.learnworlds.com/review-center';
      c.personos.portal = 'https://app.personos.example/portal';
      window.applyThriveEcosystemConfig();
      out.revNow = rev.href; out.persNow = pers.href; out.persHiddenNow = pers.hasAttribute('hidden');
      return out;
    })()`);
    check('Personos link hidden until portal URL configured', h.persHiddenDefault);
    check('Review Center falls back to school URL', (h.revDefault || '').replace(/\/$/, '') === SCHOOL, h.revDefault);
    check('Review Center + Personos update from config', h.revNow === 'https://thrive-coaching.learnworlds.com/review-center' && h.persNow.startsWith('https://app.personos.example') && !h.persHiddenNow);
    await page.close();

    console.log('Header fit: hamburger below 1360px, single-row compact nav above');
    for (const w of [1025, 1100, 1280, 1359, 1360, 1440, 1599, 1600, 1840]) {
      for (const route of ['index', 'classes', 'onboarding']) {
        page = await openPage(cdp, base, route, w, 800);
        const m = await page.evaluate(`(() => {
          const dm = document.querySelector('.desktop-menu');
          const ham = document.querySelector('.hamburger');
          const dmVisible = getComputedStyle(dm).display !== 'none';
          const hamR = ham.getBoundingClientRect();
          const links = Array.from(dm.querySelectorAll('.nav-links > li'));
          const centers = links.map(li => { const r = li.getBoundingClientRect(); return r.top + r.height / 2; });
          const tops = { size: (Math.max(...centers) - Math.min(...centers)) < 24 ? 1 : 2 };
          const last = links[links.length - 1].getBoundingClientRect();
          return { dmVisible, hamVisible: hamR.width > 0, rows: tops.size, sw: document.documentElement.scrollWidth, lastRight: Math.round(last.right) };
        })()`);
        if (w < 1360) check(`/${route} @${w}: hamburger drawer, no overflow`, !m.dmVisible && m.hamVisible && m.sw <= w, JSON.stringify(m));
        else check(`/${route} @${w}: compact nav fits on one row`, m.dmVisible && !m.hamVisible && m.rows === 1 && m.sw <= w && m.lastRight <= w, JSON.stringify(m));
        await page.close();
      }
    }
  } finally { cleanup(); server.close(); }
  console.log(`\nEcosystem config: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
