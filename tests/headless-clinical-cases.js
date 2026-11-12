#!/usr/bin/env node
/**
 * tests/headless-clinical-cases.js
 *
 * Batch 5 — clinical B2B alignment of the case-scenario pages, approach, and 404:
 *  - every scenario card carries a clinical domain, "Copy Personos Case Prompt", and
 *    "Open in Flow Survey / THRiVE Report" actions
 *  - Personos Case Prompt contains the case quote, DAP note + 167-Hour Action Board instructions,
 *    and the button label is restored after copy
 *  - original "Copy Scenario" behavior is unchanged
 *  - Flow Survey is seeded from a case statement but never overwrites saved work
 *  - approach / 404 / scenario pages use practitioner voice and contain no banned B2C/fairytale copy
 *  - no horizontal overflow at 320/375/768
 * Skips gracefully (exit 0) when no Chrome/Chromium is available.
 */
const fs = require('fs');
const path = require('path');
const { startServer, findChrome, launchChrome, openPage } = require('./headless-viewport-audit.js');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

const PAGES = [
  { route: 'rebuilding-life-challenges', cards: 4 },
  { route: 'employment-challenges', cards: 5 }
];
const BANNED = [/cinderella/i, /harry potter/i, /fairy godmother/i, /magic wand/i, /go unstuck yourself/i, /three-archetypes/i, /help you find your flow/i, /get you unstuck/i];

async function main() {
  console.log('Static copy checks');
  for (const p of ['404', 'approach', 'rebuilding-life-challenges', 'employment-challenges']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', p + '.html'), 'utf8');
    check(`public/${p}: no banned B2C / fairytale copy`, !BANNED.some(r => r.test(html)), BANNED.filter(r => r.test(html)).join(','));
    check(`public/${p}: practitioner authority (167 hours)`, /167 Hours/i.test(html));
  }
  const approach = fs.readFileSync(path.join(__dirname, '..', 'public', 'approach.html'), 'utf8');
  check('approach: SOL Theory, RellaFit, reactive character → Observer', /SOL Theory/.test(approach) && /RellaFit/.test(approach) && /reactive character/i.test(approach) && /Observer/.test(approach));
  const f404 = fs.readFileSync(path.join(__dirname, '..', 'public', '404.html'), 'utf8');
  check('404: routes to Practitioner Hub and Lab schedule', /Practitioner Hub/.test(f404) && /classes\.html/.test(f404));

  const chrome = findChrome();
  if (!chrome || typeof WebSocket === 'undefined') { console.log(`\nClinical cases (static only): ${pass} passed, ${fail} failed — headless Chrome unavailable`); process.exit(fail ? 1 : 0); }
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const { cdp, cleanup } = await launchChrome(chrome);
  try {
    for (const { route, cards } of PAGES) {
      console.log(`/${route}`);
      let page = await openPage(cdp, base, route, 1280, 900);
      const r = await page.evaluate(`(() => {
        const cs = Array.from(document.querySelectorAll('.scenario-card'));
        return { n: cs.length,
          domains: cs.map(c => c.getAttribute('data-case-domain')),
          casePrompt: cs.map(c => c.querySelectorAll('[data-case-prompt]').length),
          survey: cs.map(c => c.querySelectorAll('a[data-case-seed="survey"][href="survey.html"]').length),
          report: cs.map(c => c.querySelectorAll('a[data-case-seed="report"][href="profile.html"]').length),
          origCopy: cs.map(c => c.querySelectorAll('.copy-scenario-btn:not([data-case-prompt])').length) };
      })()`);
      check(`${cards} scenario cards`, r.n === cards, String(r.n));
      check('every card has a clinical domain', r.domains.every(d => d && d.length > 3), JSON.stringify(r.domains));
      check('every card has Copy Personos Case Prompt', r.casePrompt.every(n => n === 1));
      check('every card links to Flow Survey + THRiVE Report', r.survey.every(n => n === 1) && r.report.every(n => n === 1));
      check('original Copy Scenario button preserved', r.origCopy.every(n => n === 1));

      const copyRes = await page.evaluate(`(() => {
        window.__copied = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } } });
        const card = document.querySelector('.scenario-card');
        card.querySelector('[data-case-prompt]').click();
        return 1;
      })()`);
      await new Promise(r2 => setTimeout(r2, 300));
      const after = await page.evaluate(`(() => {
        const card = document.querySelector('.scenario-card');
        const btn = card.querySelector('[data-case-prompt]');
        const quote = card.querySelector('.scenario-prompt-quote').textContent.trim().replace(/^["\\u201C]+|["\\u201D]+$/g, '');
        return { text: window.__copied[0] || '', quote, label: btn.querySelector('.copy-btn-label').textContent, copied: btn.classList.contains('is-copied') };
      })()`);
      check('case prompt includes the client statement', after.text.includes(after.quote.slice(0, 60)));
      check('case prompt asks for DAP note + 167-Hour Action Board + 4 lenses', /DAP NOTE/.test(after.text) && /167-HOUR ACTION BOARD/.test(after.text) && /Stoic/.test(after.text) && /Executive/.test(after.text));
      check('case prompt names the domain and crisis safeguard', /Domain: /.test(after.text) && /crisis protocol/.test(after.text));
      check('button shows Copied! feedback', after.copied && /Copied/.test(after.label), after.label);
      await new Promise(r2 => setTimeout(r2, 2500));
      const restored = await page.evaluate(`document.querySelector('.scenario-card [data-case-prompt] .copy-btn-label').textContent`);
      check('label restored to "Copy Personos Case Prompt"', restored === 'Copy Personos Case Prompt', restored);
      await page.evaluate(`(() => { document.querySelector('.scenario-card .copy-scenario-btn:not([data-case-prompt])').click(); return 1; })()`);
      await new Promise(r2 => setTimeout(r2, 300));
      const orig = await page.evaluate(`window.__copied[window.__copied.length - 1]`);
      check('original Copy Scenario still copies the 3-part prompt', /This is not actually my challenge/.test(orig) && /five creative next steps/.test(orig));

      const seeded = await page.evaluate(`(() => {
        const link = document.querySelector('.scenario-card a[data-case-seed="survey"]');
        link.addEventListener('click', (e) => e.preventDefault(), { once: true });
        link.click();
        const raw = sessionStorage.getItem('thrive_case_seed_v1');
        return raw ? JSON.parse(raw) : null;
      })()`);
      check('Open in Flow Survey stores a seed in sessionStorage', seeded && seeded.target === 'survey' && seeded.text.length > 40, JSON.stringify(seeded));
      const fiveKeys = await page.evaluate(`['thrive_coaching_dossier_v1','thrive_flow_survey_state_v1'].every(k => localStorage.getItem(k) === null)`);
      check('frozen localStorage keys untouched by seeding', fiveKeys === true);
      await page.close();

      for (const w of [320, 375, 768]) {
        page = await openPage(cdp, base, route, w, 900);
        const sw = await page.evaluate(`document.documentElement.scrollWidth`);
        check(`@${w}px no horizontal overflow`, sw <= w, String(sw));
        const small = await page.evaluate(`Array.from(document.querySelectorAll('.scenario-actions a, .scenario-actions button')).filter(e => e.getBoundingClientRect().height < 44).length`);
        check(`@${w}px scenario actions >= 44px tall`, small === 0, String(small));
        await page.close();
      }
    }

    console.log('Flow Survey seeding');
    let page = await openPage(cdp, base, 'survey', 1280, 900);
    const s1 = await page.evaluate(`(() => {
      sessionStorage.setItem('thrive_case_seed_v1', JSON.stringify({ text: 'Seeded client statement for the lab.', target: 'survey', ts: Date.now() }));
      document.getElementById('problem-description').value = '';
      applyCaseSeedOnBoot();
      return { v: document.getElementById('problem-description').value, left: sessionStorage.getItem('thrive_case_seed_v1') };
    })()`);
    check('empty survey is seeded and seed consumed', s1.v === 'Seeded client statement for the lab.' && s1.left === null, JSON.stringify(s1));
    const s2 = await page.evaluate(`(() => {
      sessionStorage.setItem('thrive_case_seed_v1', JSON.stringify({ text: 'Second seed', target: 'survey', ts: Date.now() }));
      applyCaseSeedOnBoot();
      return document.getElementById('problem-description').value;
    })()`);
    check('existing text is never overwritten', s2 === 'Seeded client statement for the lab.', s2);
    const s3 = await page.evaluate(`(() => {
      document.getElementById('problem-description').value = '';
      sessionStorage.setItem('thrive_case_seed_v1', JSON.stringify({ text: 'Stale', target: 'survey', ts: Date.now() - 2 * 3600 * 1000 }));
      applyCaseSeedOnBoot();
      const a = document.getElementById('problem-description').value;
      sessionStorage.setItem('thrive_case_seed_v1', '{broken json');
      applyCaseSeedOnBoot();
      return { stale: a, corrupt: document.getElementById('problem-description').value };
    })()`);
    check('stale seed (>1h) and corrupt seed are ignored safely', s3.stale === '' && s3.corrupt === '', JSON.stringify(s3));
    await page.close();
  } finally { cleanup(); server.close(); }
  console.log(`\nClinical cases: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
