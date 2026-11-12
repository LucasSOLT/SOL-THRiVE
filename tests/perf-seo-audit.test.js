#!/usr/bin/env node
/**
 * tests/perf-seo-audit.test.js
 *
 * Batch 8 — Performance, CLS, Tailwind utility coverage, and SEO/Structured Data verification:
 *  - html2canvas is deferred on survey.html
 *  - every <img> across all 14 root HTML pages has explicit width & height attributes
 *  - every page has OG, Twitter card, and <link rel="canonical"> metadata
 *  - sitemap.xml & robots.txt exist in root and public/ and are registered in build.js & build.py
 *  - JSON-LD (EducationalOrganization, Course for Nov 30 Lab, EducationEvent for Nov 12 Lunch & Learn) parses cleanly
 *  - tailwind.css covers utility classes used by survey.html, profile.html, and hope-survey.html
 */
const fs = require('fs');
const path = require('path');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const PAGES = ['index', 'classes', 'onboarding', 'how-to-use', 'approach', 'rebuilding-life-challenges', 'employment-challenges', 'funnel', 'mockup-landing', 'landingpage', 'results', 'survey', 'profile', 'hope-survey', '404'];

console.log('1. Deferred scripts & CLS image dimensions');
const surveyPub = fs.readFileSync(path.join(PUB, 'survey.html'), 'utf8');
check('survey.html defers html2canvas', /<script[^>]+html2canvas[^>]+defer[^>]*><\/script>/.test(surveyPub));

for (const p of PAGES) {
  const html = fs.readFileSync(path.join(PUB, p + '.html'), 'utf8');
  const imgs = html.match(/<img\b[^>]*>/g) || [];
  const missing = imgs.filter(im => !(/\bwidth="\d+"/.test(im) && /\bheight="\d+"/.test(im)));
  check(`public/${p}: all ${imgs.length} <img> tags have explicit width & height`, missing.length === 0, missing.join(' | '));
}

console.log('2. OG, Twitter & canonical tags');
for (const p of PAGES) {
  const html = fs.readFileSync(path.join(PUB, p + '.html'), 'utf8');
  const ok = /property="og:title"/.test(html) &&
             /property="og:description"/.test(html) &&
             /property="og:url"/.test(html) &&
             /property="og:image"/.test(html) &&
             /name="twitter:card"/.test(html) &&
             /name="twitter:title"/.test(html) &&
             /name="twitter:description"/.test(html) &&
             /name="twitter:image"/.test(html) &&
             /<link\s+rel="canonical"\s+href="https:\/\/[^"]+"/.test(html);
  check(`public/${p}: complete OG + Twitter + canonical tags`, ok);
}

console.log('3. sitemap.xml, robots.txt & build sync');
const buildJs = fs.readFileSync(path.join(ROOT, 'build.js'), 'utf8');
const buildPy = fs.readFileSync(path.join(ROOT, 'build.py'), 'utf8');
check('build.js & build.py include sitemap.xml and robots.txt', buildJs.includes("'sitemap.xml'") && buildJs.includes("'robots.txt'") && buildPy.includes("'sitemap.xml'") && buildPy.includes("'robots.txt'"));
const smRoot = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
const smPub = fs.readFileSync(path.join(PUB, 'sitemap.xml'), 'utf8');
check('sitemap.xml synced to public/ and contains core routes', smRoot === smPub && /<urlset/.test(smPub) && /thrivecoaching\.ai\/classes/.test(smPub) && /thrivecoaching\.ai\/onboarding/.test(smPub));
const rbRoot = fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8');
const rbPub = fs.readFileSync(path.join(PUB, 'robots.txt'), 'utf8');
check('robots.txt synced to public/ and references sitemap.xml', rbRoot === rbPub && /Sitemap:\s*https:\/\/www\.thrivecoaching\.ai\/sitemap\.xml/.test(rbPub));

console.log('4. JSON-LD structured data');
for (const p of ['index', 'classes']) {
  const html = fs.readFileSync(path.join(PUB, p + '.html'), 'utf8');
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  let parsed = null;
  try { parsed = m ? JSON.parse(m[1]) : null; } catch (_) {}
  const graph = (parsed && Array.isArray(parsed['@graph'])) ? parsed['@graph'] : [];
  const types = new Set(graph.map(n => n['@type']));
  check(`public/${p}: valid JSON-LD with EducationalOrganization, Course (Nov 30), and EducationEvent (Nov 12)`,
    types.has('EducationalOrganization') && types.has('Course') && types.has('EducationEvent'));
}

console.log('5. Tailwind utility coverage');
const tw = fs.readFileSync(path.join(PUB, 'tailwind.css'), 'utf8');
for (const cls of ['text-md', 'animate-in', 'animate-fade-in', 'fill-mode-both', 'zoom-in-95']) {
  check(`tailwind.css defines .${cls}`, tw.includes('.' + cls));
}

console.log(`\nPerf & SEO audit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
