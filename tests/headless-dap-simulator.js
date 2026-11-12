#!/usr/bin/env node
/**
 * tests/headless-dap-simulator.js
 *
 * Drives the DAP Note & G.A.P.S. Action Board Simulator (how-to-use.html#dap-gaps-simulator)
 * in real headless Chrome:
 *  - presets across all 5 clinical domains, 4 lens toggles, 5 tailored steps per combination
 *  - 1-3 micro-action limit, live 167-Hour Action Board, completion meter
 *  - DAP note (Data / Assessment / Plan) reflects client, lens and board state
 *  - cached thrive_coaching_dossier_v1 is used when present; absent dossier is handled
 *  - XSS-safe rendering of dossier strings, no horizontal overflow at 320/375/768/1280
 * Skips gracefully (exit 0) when no Chrome/Chromium is available.
 */
const { startServer, findChrome, launchChrome, openPage } = require('./headless-viewport-audit.js');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

async function main() {
  const chrome = findChrome();
  if (!chrome || typeof WebSocket === 'undefined') { console.log('DAP simulator test skipped: no headless Chrome available.'); process.exit(0); }
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const { cdp, cleanup } = await launchChrome(chrome);
  try {
    let page = await openPage(cdp, base, 'how-to-use', 1280, 900);
    const J = (expr) => page.evaluate(`(() => { ${expr} })()`);

    console.log('Structure & defaults');
    const init = await J(`
      const q = (s) => document.querySelectorAll(s).length;
      return { section: q('#dap-gaps-simulator'), steps: q('#dap-steps li'), presets: q('[data-dap-source]'), lenses: q('[data-dap-lens]'),
        domains: document.querySelectorAll('#dap-domain option').length,
        note: document.getElementById('dap-note').textContent,
        errBanner: !!window.__dapErr };
    `);
    check('simulator section present', init.section === 1);
    check('4 profile sources (dossier + 3 presets)', init.presets === 4, JSON.stringify(init));
    check('4 coaching lenses', init.lenses === 4);
    check('5 clinical domains selectable', init.domains === 5);
    check('5 tailored G.A.P.S. steps rendered', init.steps === 5);
    check('DAP note has D / A / P sections', /D — DATA/.test(init.note) && /A — ASSESSMENT/.test(init.note) && /P — PLAN/.test(init.note));
    check('default preset (Marcus) quoted in Data', /Marcus \(34\)/.test(init.note) && /Addiction Recovery/.test(init.note));
    check('cached-dossier source flagged unavailable when nothing saved', await J(`return document.getElementById('dap-source-dossier').getAttribute('data-has-dossier') === 'false';`));

    console.log('Domains x lenses produce distinct, complete steps');
    const combos = await J(`
      const out = []; const seen = new Set();
      const dom = document.getElementById('dap-domain');
      for (const d of ['addiction','housing','workforce','distress','conflict']) {
        dom.value = d; dom.dispatchEvent(new Event('change', { bubbles: true }));
        for (const l of ['stoic','faith','strengths','executive']) {
          document.querySelector('[data-dap-lens="' + l + '"]').click();
          const items = Array.from(document.querySelectorAll('#dap-steps li'));
          const sig = items.map(li => li.textContent).join('|');
          seen.add(sig);
          out.push({ d, l, n: items.length, empty: items.some(li => li.textContent.trim().length < 30), unresolved: /\\{c\\}/.test(sig) });
        }
      }
      return { all: out, distinct: seen.size };
    `);
    check('20 domain × lens combinations each give 5 steps', combos.all.every(c => c.n === 5));
    check('no empty or unresolved template steps', combos.all.every(c => !c.empty && !c.unresolved));
    check('every combination is distinct', combos.distinct === 20, String(combos.distinct));

    console.log('Micro-action limit, board, and DAP note');
    await J(`document.querySelector('[data-dap-source="marcus"]').click(); document.querySelector('[data-dap-lens="strengths"]').click(); return 1;`);
    const picks = await J(`
      const nth = (i) => document.querySelectorAll('#dap-steps input[type=checkbox]')[i];
      nth(0).click(); nth(1).click(); nth(2).click();
      const afterThree = { board: document.querySelectorAll('#dap-board-list li').length, count: document.getElementById('dap-limit-count').textContent };
      nth(3).click();
      const afterFour = { board: document.querySelectorAll('#dap-board-list li').length, checked: document.querySelectorAll('#dap-steps input:checked').length, msg: document.getElementById('dap-limit-msg').textContent };
      return { afterThree, afterFour, emptyHidden: document.getElementById('dap-board-empty').hidden };
    `);
    check('three picks land on the board', picks.afterThree.board === 3 && /3 of 3/.test(picks.afterThree.count), JSON.stringify(picks.afterThree));
    check('4th pick rejected with explanation', picks.afterFour.board === 3 && picks.afterFour.checked === 3 && /up to 3/.test(picks.afterFour.msg), JSON.stringify(picks.afterFour));
    check('empty-board hint hidden once items exist', picks.emptyHidden === true);
    const done = await J(`
      document.querySelector('#dap-board-list input[type=checkbox]').click();
      return { meter: document.getElementById('dap-board-meter').textContent, note: document.getElementById('dap-note').textContent,
        windows: Array.from(document.querySelectorAll('.dap-board-window')).map(n => n.textContent) };
    `);
    check('completion meter updates', /1 of 3 done/.test(done.meter), done.meter);
    check('board shows time windows inside the 167 hours', done.windows.length === 3 && /24 hours/.test(done.windows[0]), JSON.stringify(done.windows));
    check('DAP note Plan lists 3 actions and marks completion', /1\. \[/.test(done.note) && /3\. \[/.test(done.note) && /\(completed\)/.test(done.note));
    check('DAP note records the lens', /Strengths-First Behavioral/.test(done.note));
    const unpick = await J(`
      document.querySelector('#dap-steps input:checked').click();
      return { board: document.querySelectorAll('#dap-board-list li').length };
    `);
    check('unticking removes from board', unpick.board === 2);
    const sw = await J(`document.querySelector('[data-dap-source="dana"]').click(); return { picked: window.ThriveDapSimulator.getState().picked.length, domain: document.getElementById('dap-domain').value, note: window.ThriveDapSimulator.getNote() };`);
    check('switching client resets the board and sets domain', sw.picked === 0 && sw.domain === 'workforce' && /Dana \(41\)/.test(sw.note));
    check('empty plan is explained, not blank', /No micro-action selected yet/.test(sw.note) && /\(none selected\)/.test(sw.note));

    console.log('Copy & print');
    const copyRes = await J(`
      window.__copied = null;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } } });
      document.getElementById('dap-copy-btn').click();
      return 1;
    `);
    await new Promise(r => setTimeout(r, 300));
    const copied = await J(`return { copied: window.__copied, status: document.getElementById('dap-copy-status').textContent, expected: window.ThriveDapSimulator.getNote() };`);
    check('Copy DAP Note writes the full note to the clipboard', copied.copied && copied.copied === copied.expected);
    check('copy status announced (aria-live)', /copied/i.test(copied.status));
    const prn = await J(`let called = 0; window.print = () => { called++; }; document.getElementById('dap-print-btn').click(); return { called };`);
    check('Print / Save PDF triggers window.print', prn.called === 1);
    const printCss = await J(`
      let ok = false;
      for (const sheet of Array.from(document.styleSheets)) { try { for (const r of Array.from(sheet.cssRules)) { if (r.type === CSSRule.MEDIA_RULE && /print/.test(r.conditionText || r.media.mediaText) && /dap-col-controls/.test(r.cssText)) ok = true; } } catch (_) {} }
      return ok;
    `);
    check('@media print stylesheet isolates board + note', printCss === true);
    await page.close();

    console.log('Cached dossier source');
    page = await openPage(cdp, base, 'how-to-use', 1280, 900);
    const dos = await page.evaluate(`(() => {
      localStorage.setItem('thrive_coaching_dossier_v1', JSON.stringify({
        flowSurvey: { problem: 'My landlord posted a notice and I have no idea how to cover the rent <img src=x onerror=window.__xss=1>', dimensions: { Agency: 12, Actions: 8, Support: 15, Tools: 6 } },
        thriveReport: { interviewee: 'Sam Rivera', pillars: { traits: 'Resourceful and calm', values: 'Family first' } }
      }));
      window.ThriveDapSimulator.refreshDossier();
      const btn = document.getElementById('dap-source-dossier');
      const has = btn.getAttribute('data-has-dossier');
      btn.click();
      return { has, domain: document.getElementById('dap-domain').value, note: window.ThriveDapSimulator.getNote(), xss: window.__xss === 1,
        injectedImg: document.querySelectorAll('#dap-note img').length };
    })()`);
    check('dossier source becomes available after save', dos.has === 'true');
    check('dossier problem drives domain (housing) and Data section', dos.domain === 'housing' && /Sam Rivera/.test(dos.note) && /landlord/.test(dos.note), JSON.stringify({ d: dos.domain }));
    check('dossier strengths and Flow dimensions appear in note', /Resourceful and calm/.test(dos.note) && /Tools 6\/25/.test(dos.note));
    check('dossier strings are rendered as text (no XSS)', dos.xss === false && dos.injectedImg === 0);
    const keep = await page.evaluate(`(() => JSON.parse(localStorage.getItem('thrive_coaching_dossier_v1')).flowSurvey.dimensions.Tools)()`);
    check('simulator never rewrites the dossier storage contract', keep === 6);
    await page.close();

    console.log('Corrupt dossier storage is tolerated');
    page = await openPage(cdp, base, 'how-to-use', 1280, 900);
    const bad = await page.evaluate(`(() => {
      localStorage.setItem('thrive_coaching_dossier_v1', '{not json');
      window.ThriveDapSimulator.refreshDossier();
      return { steps: document.querySelectorAll('#dap-steps li').length, has: document.getElementById('dap-source-dossier').getAttribute('data-has-dossier') };
    })()`);
    check('corrupt JSON falls back gracefully', bad.steps === 5 && bad.has === 'false');
    await page.close();

    console.log('Responsive layout');
    for (const w of [320, 375, 768, 1280]) {
      page = await openPage(cdp, base, 'how-to-use', w, 900);
      const m = await page.evaluate(`(() => { document.querySelector('#dap-steps input').click(); return { sw: document.documentElement.scrollWidth,
        small: Array.from(document.querySelectorAll('#dap-gaps-simulator button, #dap-gaps-simulator select, #dap-gaps-simulator input')).filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.height < 44 && e.tagName !== 'INPUT'); }).length,
        errs: 0 }; })()`);
      check(`@${w}px: no horizontal overflow`, m.sw <= w, `scrollWidth=${m.sw}`);
      check(`@${w}px: buttons/selects >= 44px tall`, m.small === 0, `${m.small} too small`);
      await page.close();
    }
  } finally { cleanup(); server.close(); }
  console.log(`\nDAP simulator: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
