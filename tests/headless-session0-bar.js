#!/usr/bin/env node
/**
 * tests/headless-session0-bar.js
 *
 * Session 0 Diagnostic Progress Bar / Tool Switcher + storage resilience in real headless Chrome:
 *  - bar appears on survey, profile, hope-survey, results (and NOT on other pages)
 *  - links back to onboarding.html and between the three diagnostics; current page marked aria-current
 *  - Not started / In progress / Complete badges from real storage keys; live refresh on dossier events
 *  - corrupt JSON in every frozen key never breaks the bar or the page
 *  - blocked / quota-exceeded storage: no uncaught errors, in-memory fallback, one dismissible notice
 *  - no horizontal overflow and 44px targets at 320/375/768/1280; bar hidden in print
 * Skips gracefully (exit 0) when no Chrome/Chromium is available.
 */
const { startServer, findChrome, launchChrome, openPage } = require('./headless-viewport-audit.js');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

const BAR_PAGES = ['survey', 'profile', 'hope-survey', 'results'];
const NO_BAR_PAGES = ['index', 'classes', 'onboarding', 'how-to-use', 'approach'];

async function main() {
  const chrome = findChrome();
  if (!chrome || typeof WebSocket === 'undefined') { console.log('Session 0 bar test skipped: no headless Chrome available.'); process.exit(0); }
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const { cdp, cleanup } = await launchChrome(chrome);
  try {
    console.log('Presence, links, current-page marking');
    for (const route of BAR_PAGES) {
      const page = await openPage(cdp, base, route, 1280, 900);
      const r = await page.evaluate(`(() => {
        const bar = document.querySelector('[data-session0-bar]');
        if (!bar) return null;
        const hub = bar.querySelector('a.session0-hub-link');
        const steps = Array.from(bar.querySelectorAll('a.session0-step'));
        return { count: document.querySelectorAll('[data-session0-bar]').length, hubHref: hub && hub.getAttribute('href'), hubText: hub && hub.textContent,
          hrefs: steps.map(a => a.getAttribute('href')), current: steps.filter(a => a.getAttribute('aria-current') === 'page').map(a => a.getAttribute('href')),
          statuses: steps.map(a => a.getAttribute('data-status')), label: bar.getAttribute('aria-label'),
          afterHeader: bar.previousElementSibling && bar.previousElementSibling.tagName === 'HEADER' };
      })()`);
      check(`/${route}: bar present exactly once`, r && r.count === 1);
      if (!r) continue;
      check(`/${route}: links back to Session 0 Pre-Flight Hub`, r.hubHref === 'onboarding.html' && /Session 0 Pre-Flight Hub/.test(r.hubText));
      check(`/${route}: tool switcher links to all 3 diagnostics`, JSON.stringify(r.hrefs) === JSON.stringify(['survey.html', 'profile.html', 'hope-survey.html']));
      const expectCurrent = route === 'results' ? [] : [route + '.html'];
      check(`/${route}: current page marked aria-current`, JSON.stringify(r.current) === JSON.stringify(expectCurrent), JSON.stringify(r.current));
      check(`/${route}: starts as Not started on clean storage`, r.statuses.every(s => s === 'todo'), JSON.stringify(r.statuses));
      check(`/${route}: bar is a labelled nav placed after the header`, r.label === 'Session 0 diagnostic progress' && r.afterHeader === true);
      await page.close();
    }
    for (const route of NO_BAR_PAGES) {
      const page = await openPage(cdp, base, route, 1280, 900);
      const n = await page.evaluate(`document.querySelectorAll('[data-session0-bar]').length`);
      check(`/${route}: no bar on non-diagnostic page`, n === 0);
      await page.close();
    }

    console.log('Status badges from real storage');
    let page = await openPage(cdp, base, 'survey', 1280, 900);
    const st = await page.evaluate(`(() => {
      const out = {};
      const get = () => Array.from(document.querySelectorAll('a.session0-step')).map(a => a.getAttribute('data-status')).join(',');
      localStorage.setItem('thrive_flow_survey_state_v1', JSON.stringify({ problemDescription: 'Cravings after work', answered: [], scores: [] }));
      window.ThriveSession0Bar.refresh();
      out.flowProgress = get();
      localStorage.setItem('thrive_profile_state_v1', JSON.stringify({ userDetails: { interviewee: 'Alex Morgan' } }));
      localStorage.setItem('thrive_hope_survey_state_v1', JSON.stringify({ answers: { ops_home: 4 } }));
      window.ThriveSession0Bar.refresh();
      out.allProgress = get();
      localStorage.setItem('thrive_coaching_dossier_v1', JSON.stringify({
        flowSurvey: { problem: 'Cravings after work', dimensions: { Agency: 10 } },
        thriveReport: { interviewee: 'Alex', pillars: { traits: 'Calm' } }
      }));
      window.dispatchEvent(new CustomEvent('thrive-dossier-updated'));
      out.twoDone = get();
      out.countText = document.querySelector('.session0-count').textContent;
      out.dataCount = document.querySelector('[data-session0-bar]').getAttribute('data-complete-count');
      out.label = document.querySelector('a[data-s0-tool="flow"]').getAttribute('aria-label');
      localStorage.setItem('thrive_coaching_dossier_v1', JSON.stringify({
        flowSurvey: { problem: 'x problem' }, thriveReport: { pillars: { traits: 'Calm' } }, hopeIndex: { totalHoPEScore100: 61 }
      }));
      window.dispatchEvent(new CustomEvent('thrive-dossier-updated'));
      out.allDone = get();
      out.countAll = document.querySelector('.session0-count').textContent;
      return out;
    })()`);
    check('flow draft shows In progress', st.flowProgress === 'progress,todo,todo', st.flowProgress);
    check('profile + hope drafts show In progress', st.allProgress === 'progress,progress,progress', st.allProgress);
    check('dossier updates flip badges to Complete live', st.twoDone === 'complete,complete,progress', st.twoDone);
    check('count text and aria reflect progress', st.countText === '2 of 3 complete' && st.dataCount === '2' && /Flow Survey: Complete \(current page\)/.test(st.label), JSON.stringify(st));
    check('all three complete', st.allDone === 'complete,complete,complete' && st.countAll === '3 of 3 complete', st.allDone);
    await page.close();

    console.log('Corrupt JSON in every frozen key');
    for (const route of BAR_PAGES) {
      page = await openPage(cdp, base, route, 1280, 900);
      const bad = await page.evaluate(`(() => {
        const keys = ['thrive_coaching_dossier_v1','thrive_flow_survey_state_v1','thrive_hope_survey_state_v1','thrive_onboarding_checklist_v1','thrive_profile_state_v1','solThrive','solThriveLead','solThriveVotes'];
        keys.forEach(k => localStorage.setItem(k, '{corrupt'));
        sessionStorage.setItem('solThrive', '][');
        let err = null;
        try { window.ThriveSession0Bar.refresh(); window.ThriveCoachingDossier.readDossier(); } catch (e) { err = String(e); }
        return { err, statuses: Array.from(document.querySelectorAll('a.session0-step')).map(a => a.getAttribute('data-status')).join(','), body: document.body.textContent.length > 200 };
      })()`);
      check(`/${route}: corrupt JSON everywhere is tolerated`, bad.err === null && bad.statuses === 'todo,todo,todo' && bad.body, JSON.stringify(bad));
      await page.close();
    }

    console.log('Blocked / full storage');
    for (const route of ['survey', 'profile', 'hope-survey', 'results']) {
      page = await openPage(cdp, base, route, 1280, 900);
      const q = await page.evaluate(`(() => {
        const errs = [];
        window.addEventListener('error', (e) => errs.push(String(e.message)));
        const quota = () => { const e = new Error('full'); e.name = 'QuotaExceededError'; e.code = 22; throw e; };
        Storage.prototype.setItem = quota;
        Storage.prototype.getItem = function () { throw new Error('SecurityError'); };
        let r = {};
        try {
          r.setResult = ThriveStorage.set('local', 'thrive_flow_survey_state_v1', '{"a":1}');
          r.memoryRead = ThriveStorage.get('local', 'thrive_flow_survey_state_v1');
          window.ThriveSession0Bar.refresh();
          window.ThriveCoachingDossier.readDossier();
        } catch (e) { r.err = String(e); }
        r.notice = document.querySelectorAll('#thrive-storage-notice').length;
        r.noticeText = (document.getElementById('thrive-storage-notice') || {}).textContent || '';
        r.errs = errs;
        r.degraded = ThriveStorage.isDegraded();
        return r;
      })()`);
      check(`/${route}: quota + blocked reads/writes never throw`, !q.err && q.setResult === false && q.memoryRead === '{"a":1}' && q.degraded === true, JSON.stringify(q));
      check(`/${route}: one actionable notice pointing to dossier export`, q.notice === 1 && /Export \/ Copy Clinical Dossier/.test(q.noticeText));
      const dismiss = await page.evaluate(`(() => { document.querySelector('#thrive-storage-notice button').click(); return document.querySelectorAll('#thrive-storage-notice').length; })()`);
      check(`/${route}: notice is dismissible`, dismiss === 0);
      await page.close();
    }

    console.log('Responsive + print');
    for (const route of BAR_PAGES) {
      for (const w of [320, 375, 768, 1280]) {
        page = await openPage(cdp, base, route, w, 900);
        const m = await page.evaluate(`(() => {
          const els = Array.from(document.querySelectorAll('[data-session0-bar] a'));
          return { sw: document.documentElement.scrollWidth, small: els.filter(e => e.getBoundingClientRect().height < 43.5).length,
            right: Math.max.apply(null, els.map(e => Math.round(e.getBoundingClientRect().right))) };
        })()`);
        check(`/${route} @${w}: bar fits, targets >= 44px`, m.sw <= w && m.small === 0 && m.right <= w, JSON.stringify(m));
        await page.close();
      }
    }
    page = await openPage(cdp, base, 'survey', 1280, 900);
    const printHidden = await page.evaluate(`(() => {
      let hidden = false;
      for (const sheet of Array.from(document.styleSheets)) { try { for (const r of Array.from(sheet.cssRules)) { if (r.type === CSSRule.MEDIA_RULE && /print/.test(r.media.mediaText) && /session0-bar/.test(r.cssText) && /display:\\s*none/.test(r.cssText)) hidden = true; } } catch (_) {} }
      return hidden && document.querySelector('[data-session0-bar]').classList.contains('no-print');
    })()`);
    check('bar is hidden when printing', printHidden === true);
    await page.close();
  } finally { cleanup(); server.close(); }
  console.log(`\nSession 0 bar: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
