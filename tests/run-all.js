#!/usr/bin/env node
/**
 * tests/run-all.js — Master test orchestrator for SOL-THRiVE (`npm test`).
 *
 * Runs sequentially:
 *  - scripts/verify-site.js (JS syntax, links/anchors, leaked keys/placeholders, Babel/Tailwind/fairytale bans, funnel parity, build sync)
 *  - tests/e2e-runner.js --strict
 *  - All adversarial & tier suites (adversarial-m1..m4, challenger, stress, tier1..tier4)
 *  - tests/api-serverless.test.js (all 6 Vercel serverless functions)
 *  - tests/storage-safe.test.js & tests/perf-seo-audit.test.js
 *  - Headless Chromium suites (headless-viewport-audit.js @ 375/768/1280, mobile-nav, ecosystem-config, dap-simulator, clinical-cases, session0-bar, wcag-audit)
 *
 * Exits 0 if and only if every suite exits 0.
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const skipHeadless = process.argv.includes('--no-headless');

const SUITES = [
  { name: 'Site Verifier (scripts/verify-site.js)', cmd: ['scripts/verify-site.js'] },
  { name: 'E2E Runner (--strict)', cmd: ['tests/e2e-runner.js', '--strict'] },
  { name: 'Adversarial M1', cmd: ['tests/adversarial-m1.js'] },
  { name: 'Adversarial M1-2', cmd: ['tests/adversarial-m1-2.js'] },
  { name: 'Adversarial Challenger M1', cmd: ['tests/adversarial-challenger-m1.js'] },
  { name: 'Adversarial M2', cmd: ['tests/adversarial-m2.js'] },
  { name: 'Adversarial Challenger M2', cmd: ['tests/adversarial-challenger-m2.js'] },
  { name: 'Adversarial Challenger M2-2', cmd: ['tests/adversarial-challenger-m2-2.js'] },
  { name: 'Adversarial Stress M2', cmd: ['tests/adversarial-stress-m2.js'] },
  { name: 'Adversarial M3', cmd: ['tests/adversarial-m3.js'] },
  { name: 'Adversarial Challenger M3', cmd: ['tests/adversarial-challenger-m3.js'] },
  { name: 'Adversarial M4', cmd: ['tests/adversarial-m4.js'] },
  { name: 'Tier 1 Features', cmd: ['tests/tier1-features.js'] },
  { name: 'Tier 2 Boundaries', cmd: ['tests/tier2-boundaries.js'] },
  { name: 'Tier 3 Combinations', cmd: ['tests/tier3-combinations.js'] },
  { name: 'Tier 4 Scenarios', cmd: ['tests/tier4-scenarios.js'] },
  { name: 'Serverless API Suite (6 endpoints)', cmd: ['tests/api-serverless.test.js'] },
  { name: 'Storage Resilience Unit Suite', cmd: ['tests/storage-safe.test.js'] },
  { name: 'Performance & SEO Audit Suite', cmd: ['tests/perf-seo-audit.test.js'] },
  ...(skipHeadless ? [] : [
    { name: 'Headless Mobile Nav Drawer', cmd: ['tests/headless-mobile-nav.js'] },
    { name: 'Headless Ecosystem Config & Header Fit', cmd: ['tests/headless-ecosystem-config.js'] },
    { name: 'Headless DAP & G.A.P.S. Simulator', cmd: ['tests/headless-dap-simulator.js'] },
    { name: 'Headless Clinical Case Scenarios', cmd: ['tests/headless-clinical-cases.js'] },
    { name: 'Headless Session 0 Progress Bar & Storage', cmd: ['tests/headless-session0-bar.js'] },
    { name: 'Headless WCAG 2.1 AA Audit', cmd: ['tests/headless-wcag-audit.js'] },
    { name: 'Headless Viewport Audit (375/768/1280 across all routes)', cmd: ['tests/headless-viewport-audit.js'] }
  ])
];

const results = [];
let failedCount = 0;
const startedAt = Date.now();

console.log('========================================================================');
console.log(`  SOL-THRiVE Full Verification Suite (${SUITES.length} suites)`);
console.log('========================================================================');

for (const suite of SUITES) {
  const t0 = Date.now();
  process.stdout.write(`• Running ${suite.name} ... `);
  const res = spawnSync(process.execPath, suite.cmd, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const ok = res.status === 0;
  if (ok) {
    console.log(`PASS (${elapsed}s)`);
  } else {
    failedCount++;
    console.log(`FAIL (exit ${res.status}, ${elapsed}s)`);
    const combined = `${res.stdout || ''}\n${res.stderr || ''}`.trim().split('\n').slice(-25).join('\n');
    console.error(combined);
  }
  results.push({ name: suite.name, ok, elapsed });
}

const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log('========================================================================');
console.log(`  Summary: ${SUITES.length - failedCount}/${SUITES.length} suites passed in ${totalSec}s`);
console.log('========================================================================');

process.exit(failedCount === 0 ? 0 : 1);
