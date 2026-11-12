#!/usr/bin/env node
/**
 * tests/headless-mobile-nav.js
 *
 * Verifies the mobile navigation drawer in real headless Chrome at 375px:
 *  - hamburger is >= 44x44px
 *  - opening locks page scroll (html/body overflow hidden) and sets aria-expanded
 *  - Escape closes the drawer, releases the scroll lock and restores focus to the hamburger
 *  - clicking the drawer backdrop closes it and releases the scroll lock
 *  - drawer links meet the 44px touch-target minimum
 * Skips gracefully (exit 0) when no Chrome/Chromium is available.
 */
const { startServer, findChrome, launchChrome, openPage } = require('./headless-viewport-audit.js');

const PAGES = ['index', 'classes', 'approach', 'how-to-use', 'onboarding', 'rebuilding-life-challenges', 'employment-challenges', '404', 'survey', 'profile', 'hope-survey'];

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

const STATE = `(() => {
  const m = document.querySelector('.nav-menu'); const h = document.querySelector('.hamburger');
  if (!m || !h) return null;
  const hr = h.getBoundingClientRect();
  return {
    open: m.classList.contains('open'),
    expanded: h.getAttribute('aria-expanded'),
    htmlOverflow: getComputedStyle(document.documentElement).overflow,
    bodyOverflow: getComputedStyle(document.body).overflow,
    hamburgerW: Math.round(hr.width), hamburgerH: Math.round(hr.height),
    focusIsHamburger: document.activeElement === h,
    smallLinks: m.classList.contains('open') ? Array.from(m.querySelectorAll('a')).filter((a) => { const r = a.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 43.5; }).map((a) => a.textContent.trim()) : []
  };
})()`;

async function key(page, k) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: 27 });
}
async function tap(page, x, y) {
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const chrome = findChrome();
  if (!chrome || typeof WebSocket === 'undefined') { console.log('Mobile nav test skipped: no headless Chrome available.'); process.exit(0); }
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const { cdp, cleanup } = await launchChrome(chrome);
  try {
    for (const route of PAGES) {
      console.log(`/${route}`);
      const page = await openPage(cdp, base, route, 375, 812);
      const s0 = await page.evaluate(STATE);
      if (!s0) { console.log('  (no drawer on this page)'); await page.close(); continue; }
      check('hamburger >= 44x44', s0.hamburgerW >= 44 && s0.hamburgerH >= 44, `${s0.hamburgerW}x${s0.hamburgerH}`);
      check('drawer starts closed / unlocked', !s0.open && s0.bodyOverflow !== 'hidden');

      await page.evaluate(`document.querySelector('.hamburger').click()`); await wait(450);
      const s1 = await page.evaluate(STATE);
      check('opens + aria-expanded=true', s1.open && s1.expanded === 'true');
      check('scroll lock engaged', s1.htmlOverflow === 'hidden' || s1.bodyOverflow === 'hidden');
      check('drawer links >= 44px tall', s1.smallLinks.length === 0, s1.smallLinks.join(', '));

      await key(page, 'Escape'); await wait(450);
      const s2 = await page.evaluate(STATE);
      check('Escape closes + releases scroll lock', !s2.open && s2.expanded === 'false' && s2.htmlOverflow !== 'hidden' && s2.bodyOverflow !== 'hidden');
      check('Escape restores focus to hamburger', s2.focusIsHamburger);

      await page.evaluate(`document.querySelector('.hamburger').click()`); await wait(450);
      await tap(page, 6, 600); await wait(450);
      const s3 = await page.evaluate(STATE);
      check('backdrop click closes + releases scroll lock', !s3.open && s3.htmlOverflow !== 'hidden' && s3.bodyOverflow !== 'hidden');
      check('no page errors', page.issues.filter((i) => !/React|ReactDOM|html2canvas/.test(i)).length === 0, page.issues.join(' | '));
      await page.close();
    }
  } finally { cleanup(); server.close(); }
  console.log(`\nMobile nav drawer: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
