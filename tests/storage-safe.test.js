#!/usr/bin/env node
/**
 * tests/storage-safe.test.js — unit tests for storage-safe.js (no browser needed).
 * Covers: normal read/write, blocked storage (SecurityError on access), QuotaExceededError,
 * throwing getItem, corrupt JSON, in-memory fallback, one-time notice, Storage-compatible facade.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

const src = fs.readFileSync(path.join(__dirname, '..', 'storage-safe.js'), 'utf8');

function makeStore(opts = {}) {
  const data = new Map();
  return {
    getItem(k) { if (opts.throwGet) throw new Error('SecurityError'); return data.has(k) ? data.get(k) : null; },
    setItem(k, v) {
      if (opts.throwSet) { const e = new Error('quota'); e.name = 'QuotaExceededError'; e.code = 22; throw e; }
      if (opts.throwSetSecurity) { const e = new Error('denied'); e.name = 'SecurityError'; throw e; }
      data.set(k, String(v));
    },
    removeItem(k) { if (opts.throwRemove) throw new Error('nope'); data.delete(k); },
    _data: data
  };
}

function makeEnv(storageOpts = {}, sessionOpts = {}, blockAccess = false) {
  const appended = [];
  const events = [];
  const body = { appendChild: (n) => { appended.push(n); n.parentNode = body; }, removeChild: (n) => { const i = appended.indexOf(n); if (i >= 0) appended.splice(i, 1); } };
  const doc = {
    body, readyState: 'complete',
    getElementById: (id) => appended.find(n => n.id === id) || null,
    createElement: () => { const el = { style: {}, children: [], setAttribute() {}, addEventListener() {}, appendChild(c) { el.children.push(c); } }; return el; },
    addEventListener() {}
  };
  const win = { document: doc, dispatchEvent: (e) => events.push(e), CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; } };
  const local = makeStore(storageOpts);
  const session = makeStore(sessionOpts);
  if (blockAccess) {
    Object.defineProperty(win, 'localStorage', { get() { throw new Error('SecurityError: blocked'); } });
    Object.defineProperty(win, 'sessionStorage', { get() { throw new Error('SecurityError: blocked'); } });
  } else {
    win.localStorage = local; win.sessionStorage = session;
  }
  win.window = win;
  vm.runInNewContext(src, win);
  return { win, ts: win.ThriveStorage, appended, events, local, session };
}

console.log('Normal storage');
{
  const { ts, local, events } = makeEnv();
  check('exports API', ['get', 'set', 'remove', 'getJSON', 'setJSON', 'available', 'isDegraded', 'local', 'session'].every(k => k in ts));
  check('set returns true and persists', ts.set('local', 'k', 'v') === true && local._data.get('k') === 'v');
  check('get reads value', ts.get('local', 'k') === 'v');
  check('missing key returns null', ts.get('local', 'nope') === null);
  check('setJSON/getJSON round-trip', ts.setJSON('local', 'j', { a: [1, 2] }) === true && ts.getJSON('local', 'j').a[1] === 2);
  check('remove deletes', ts.remove('local', 'k') === true && ts.get('local', 'k') === null);
  check('available() true', ts.available('local') === true && ts.available('session') === true);
  check('no warning emitted', !ts.isDegraded() && events.length === 0);
  ts.local.setItem('f', 'x');
  check('Storage-compatible facade works', ts.local.getItem('f') === 'x'); ts.local.removeItem('f'); check('facade removeItem', ts.local.getItem('f') === null);
}

console.log('Corrupt JSON');
{
  const { ts } = makeEnv();
  ts.set('local', 'bad', '{not json');
  check('getJSON returns null for corrupt JSON', ts.getJSON('local', 'bad') === null);
  check('getJSON honors fallback', JSON.stringify(ts.getJSON('local', 'bad', { ok: 1 })) === '{"ok":1}');
  check('getJSON missing key honors fallback', ts.getJSON('local', 'missing', []).length === 0);
  const circ = {}; circ.self = circ;
  check('setJSON with circular value returns false, no throw', ts.setJSON('local', 'c', circ) === false);
}

console.log('QuotaExceededError');
{
  const { ts, appended, events } = makeEnv({ throwSet: true });
  let threw = false; let ok;
  try { ok = ts.set('local', 'big', 'payload'); } catch (_) { threw = true; }
  check('set never throws and returns false', !threw && ok === false);
  check('value readable from in-memory fallback', ts.get('local', 'big') === 'payload');
  check('degraded flag set', ts.isDegraded() === true);
  check('thrive-storage-warning event fired (quota)', events.length === 1 && events[0].type === 'thrive-storage-warning' && events[0].detail.reason === 'quota');
  check('single dismissible notice injected', appended.length === 1 && appended[0].id === 'thrive-storage-notice');
  ts.set('local', 'big2', 'p2');
  check('notice shown only once', appended.length === 1 && events.length === 1);
  ts.remove('local', 'big');
  check('remove clears in-memory fallback', ts.get('local', 'big') === null);
}

console.log('Blocked storage (Safari private / cookies disabled)');
{
  const { ts, events } = makeEnv({}, {}, true);
  let threw = false; let ok; let got;
  try { ok = ts.set('local', 'k', 'v'); got = ts.get('local', 'k'); ts.remove('local', 'k'); } catch (_) { threw = true; }
  check('accessing window.localStorage that throws is survived', !threw && ok === false);
  check('same-page memory fallback keeps working', got === 'v');
  check('available() false', ts.available('local') === false);
  check('warning reason is blocked', events.length === 1 && events[0].detail.reason === 'blocked');
}
{
  const { ts } = makeEnv({ throwGet: true, throwRemove: true });
  let threw = false; let v;
  try { v = ts.get('local', 'x'); ts.remove('local', 'x'); } catch (_) { threw = true; }
  check('throwing getItem/removeItem are swallowed', !threw && v === null);
}
{
  const { ts } = makeEnv({ throwSetSecurity: true });
  check('SecurityError on setItem is survived', ts.set('local', 'a', 'b') === false && ts.get('local', 'a') === 'b');
}

console.log('Session storage isolated from local');
{
  const { ts } = makeEnv();
  ts.set('session', 'k', 's'); ts.set('local', 'k', 'l');
  check('separate areas', ts.get('session', 'k') === 's' && ts.get('local', 'k') === 'l');
}

console.log(`\nstorage-safe: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
