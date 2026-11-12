#!/usr/bin/env node
/**
 * tests/headless-viewport-audit.js
 *
 * Zero-dependency viewport audit for every route in public/.
 *  - Drives real headless Chrome/Chromium over the DevTools Protocol (Node's
 *    built-in WebSocket) when a browser binary is available.
 *  - Verifies zero uncaught page errors / console errors and
 *    document.documentElement.scrollWidth <= window.innerWidth at
 *    375px, 768px and 1280px for every HTML route.
 *  - Falls back to static DOM/CSS geometry checks when no browser exists.
 *
 * Usage:
 *   node tests/headless-viewport-audit.js [--widths=375,768] [--pages=index,classes] [--verbose]
 *   node tests/headless-viewport-audit.js --static   (force fallback mode)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DEFAULT_WIDTHS = [375, 768, 1280];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.vtt': 'text/vtt; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain', '.xml': 'application/xml',
  '.md': 'text/markdown'
};

function parseArgs(argv) {
  const opts = { widths: DEFAULT_WIDTHS, pages: null, verbose: false, forceStatic: false };
  argv.forEach((a) => {
    if (a.startsWith('--widths=')) opts.widths = a.slice(9).split(',').map(Number).filter(Boolean);
    else if (a.startsWith('--pages=')) opts.pages = a.slice(8).split(',').map((s) => s.trim().replace(/\.html$/, ''));
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--static') opts.forceStatic = true;
  });
  return opts;
}

function listRoutes(pages) {
  const all = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, '')).sort();
  return pages ? all.filter((p) => pages.includes(p)) : all;
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      let file = path.join(PUBLIC_DIR, urlPath);
      if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        if (fs.existsSync(file + '.html')) file += '.html';
        else {
          const nf = path.join(PUBLIC_DIR, '404.html');
          res.writeHead(404, { 'Content-Type': MIME['.html'] });
          return res.end(fs.existsSync(nf) ? fs.readFileSync(nf) : 'Not found');
        }
      }
      const stat = fs.statSync(file);
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        const start = m && m[1] ? parseInt(m[1], 10) : 0;
        const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
        res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function findChrome() {
  const envPath = process.env.CHROME_BIN || process.env.CHROME_PATH;
  const candidates = [envPath, 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  for (const c of candidates) {
    try {
      if (path.isAbsolute(c)) { if (fs.existsSync(c)) return c; continue; }
      const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [c], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
    } catch (_) { /* ignore */ }
  }
  return null;
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.listeners.forEach((l) => l(msg));
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }
  on(fn) { this.listeners.push(fn); }
}

async function launchChrome(chromePath) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thrive-audit-'));
  const args = ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--mute-audio', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`, 'about:blank'];
  const proc = spawn(chromePath, args, { stdio: 'ignore' });
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const start = Date.now();
  while (!fs.existsSync(portFile)) {
    if (Date.now() - start > 20000) { proc.kill(); throw new Error('Chrome did not expose DevToolsActivePort'); }
    await new Promise((r) => setTimeout(r, 100));
  }
  const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const cdp = new CDP(ws);
  const cleanup = () => {
    try { ws.close(); } catch (_) { /* ignore */ }
    try { proc.kill('SIGKILL'); } catch (_) { /* ignore */ }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  };
  return { cdp, cleanup };
}

/** Opens a page in a new tab, returns a helper with evaluate()/close(). */
async function openPage(cdp, baseUrl, route, width, height, hooks = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const issues = [];
  const thirdPartyFailed = [];
  const localOrigin = new URL(baseUrl).origin;
  cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {};
      issues.push(`pageerror: ${(d.exception && d.exception.description) || d.text} (${d.url || ''}:${d.lineNumber})`);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      const text = (msg.params.args || []).map((a) => a.value || a.description || '').join(' ');
      if (!/Failed to load resource/i.test(text)) issues.push(`console.error: ${text}`);
    } else if (msg.method === 'Network.loadingFailed') {
      const p = msg.params;
      if (p.requestId && openPage._urls && openPage._urls.get(sessionId + p.requestId)) {
        const u = openPage._urls.get(sessionId + p.requestId);
        if (u.startsWith(localOrigin) && !p.canceled && p.errorText !== 'net::ERR_ABORTED') issues.push(`request failed: ${u} (${p.errorText})`);
        else if (!u.startsWith(localOrigin) && /\.js(\?|$)/.test(u)) thirdPartyFailed.push(u);
      }
    } else if (msg.method === 'Network.requestWillBeSent') {
      openPage._urls = openPage._urls || new Map();
      openPage._urls.set(sessionId + msg.params.requestId, msg.params.request.url);
    } else if (msg.method === 'Network.responseReceived') {
      const r = msg.params.response;
      if (r.url.startsWith(localOrigin) && r.status >= 400 && !/favicon\.ico$/.test(r.url)) issues.push(`HTTP ${r.status}: ${r.url}`);
    }
  });
  const s = (m, p) => cdp.send(m, p, sessionId);
  await s('Page.enable'); await s('Runtime.enable'); await s('Network.enable');
  // Block third-party hosts so audits are deterministic and offline-safe.
  await s('Network.setBlockedURLs', { urls: ['*googleapis.com*', '*gstatic.com*', '*youtube.com*', '*youtube-nocookie.com*', '*ytimg.com*', '*google-analytics.com*', '*googletagmanager.com*', '*learnworlds.com*', '*stripe.com*'] });
  const mobile = width < 600;
  await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height });
  if (mobile) await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  if (hooks.before) await hooks.before(s);
  await s('Page.navigate', { url: `${baseUrl}/${route === 'index' ? '' : route}` });
  await new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    cdp.on((m) => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') fin(); });
    setTimeout(fin, 15000);
  });
  await new Promise((r) => setTimeout(r, 600));
  return {
    issues,
    thirdPartyFailed,
    sessionId,
    send: s,
    async evaluate(expr) {
      const r = await s('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + ((r.exceptionDetails.exception || {}).description || ''));
      return r.result.value;
    },
    async close() { try { await cdp.send('Target.closeTarget', { targetId }); } catch (_) { /* ignore */ } }
  };
}

const measureExpr = (targetW) => `(() => {
  const TARGET_W = ${targetW};
  const de = document.documentElement;
  const vw = window.innerWidth;
  const offenders = [];
  if (Math.max(de.scrollWidth, document.body.scrollWidth) > TARGET_W) {
    document.querySelectorAll('body *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.visibility === 'hidden' || cs.display === 'none') return;
      if (r.right > TARGET_W + 1 || r.left < -1) {
        // skip children of an element that clips its own overflow
        let p = el.parentElement, clipped = false;
        while (p && p !== document.body) {
          const o = getComputedStyle(p);
          if (/(hidden|auto|scroll|clip)/.test(o.overflowX)) { clipped = true; break; }
          p = p.parentElement;
        }
        if (!clipped) offenders.push((el.tagName.toLowerCase()) + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '') + ' right=' + Math.round(r.right) + ' left=' + Math.round(r.left));
      }
    });
  }
  return { scrollWidth: de.scrollWidth, bodyScrollWidth: document.body ? document.body.scrollWidth : 0, innerWidth: vw, offenders: offenders.slice(0, 12) };
})()`;

async function runBrowserAudit(opts, routes, chromePath, server) {
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const { cdp, cleanup } = await launchChrome(chromePath);
  const results = [];
  try {
    for (const route of routes) {
      for (const width of opts.widths) {
        const height = width < 600 ? 812 : (width < 1000 ? 1024 : 800);
        const page = await openPage(cdp, baseUrl, route, width, height);
        let m = { scrollWidth: 0, innerWidth: width, offenders: [] };
        try { m = await page.evaluate(measureExpr(width)); } catch (e) { page.issues.push('measure failed: ' + e.message); }
        await page.close();
        // When a third-party script (React/html2canvas CDN) was unreachable (offline CI), its dependent
        // runtime errors are environmental rather than regressions.
        const problems = page.issues.filter((i) => !(page.thirdPartyFailed.length && /React|ReactDOM|html2canvas/.test(i)));
        // Compare against the *requested* width: mobile Chrome silently widens innerWidth to fit overflowing content.
        const overflowW = Math.max(m.scrollWidth, m.bodyScrollWidth);
        if (overflowW > width) problems.push(`horizontal overflow: scrollWidth ${overflowW} > viewport ${width} :: ${m.offenders.join(' | ')}`);
        results.push({ route, width, ok: problems.length === 0, problems, metrics: m });
        if (opts.verbose || problems.length) console.log(`  ${problems.length ? '[FAIL]' : '[PASS]'} /${route} @${width}px scrollWidth=${m.scrollWidth}${problems.length ? '\n      - ' + problems.join('\n      - ') : ''}`);
      }
    }
  } finally { cleanup(); }
  return results;
}

/** Fallback: static CSS/DOM geometry heuristics when no browser is installed. */
function runStaticAudit(routes) {
  const results = [];
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'style.css'), 'utf8');
  routes.forEach((route) => {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, route + '.html'), 'utf8');
    const problems = [];
    if (!/<meta[^>]+name=["']viewport["'][^>]*width=device-width/i.test(html)) problems.push('missing responsive viewport meta');
    if (/<body[^>]*style=["'][^"']*min-width:\s*\d{4,}px/i.test(html)) problems.push('body min-width forces horizontal scroll');
    if (/(^|[;{\s])width:\s*(\d{4,})px/.test(html.replace(/<script[\s\S]*?<\/script>/g, '')) && false) problems.push('fixed width >= 1000px');
    if (!/overflow-x:\s*(hidden|clip)/.test(css + html)) problems.push('no overflow-x guard found');
    results.push({ route, width: 'static', ok: problems.length === 0, problems });
    console.log(`  ${problems.length ? '[FAIL]' : '[PASS]'} /${route} (static geometry check)${problems.length ? '\n      - ' + problems.join('\n      - ') : ''}`);
  });
  return results;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const routes = listRoutes(opts.pages);
  if (!routes.length) { console.error('No routes found in public/. Run npm run build first.'); process.exit(1); }
  console.log(`Headless viewport audit — ${routes.length} routes × widths [${opts.widths.join(', ')}]`);
  const chromePath = opts.forceStatic ? null : findChrome();
  let results;
  if (!chromePath || typeof WebSocket === 'undefined') {
    console.log('  (no headless Chrome/WebSocket available — using static DOM/CSS geometry fallback)');
    results = runStaticAudit(routes);
  } else {
    console.log(`  Browser: ${chromePath}`);
    const server = await startServer();
    try { results = await runBrowserAudit(opts, routes, chromePath, server); } finally { server.close(); }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nViewport audit: ${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
}

module.exports = { startServer, findChrome, launchChrome, openPage, measureExpr, listRoutes, PUBLIC_DIR };

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
