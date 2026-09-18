/**
 * Screen recording of the real app for the launch video.
 *
 *   node scripts/demo-record.mjs <baseUrl> <outDir> [--mock]
 *
 * Walks a new visitor through the product: landing → sign up → chat answer streaming
 * in → the AI Coins being spent → the provider page with a GPU online → badges.
 * With --mock (and BSW_TEST_KEY) it attaches the deterministic test provider, so the
 * recording still works when no volunteer GPU happens to be online.
 */
import { chromium } from '@playwright/test';
import { mkdir, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { MockProvider } from '../tests/mock-provider.js';

const BASE = process.argv[2] || 'http://127.0.0.1:3111';
const OUT = process.argv[3] || '/tmp/bsw-demo';
const USE_MOCK = process.argv.includes('--mock');
const TEST_KEY = process.env.BSW_TEST_KEY || '';
const PASSWORD = 'demo-password-2026';
const NAME = `demo${Date.now().toString(36).slice(-4)}`;

const pause = (page, ms) => page.waitForTimeout(ms);

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
await page.addInitScript(() => localStorage.setItem('bsw-theme', 'dark'));

let provider = null;
let helperCtx = null;
if (USE_MOCK && TEST_KEY) {
  helperCtx = await browser.newContext();
  const helper = await helperCtx.newPage();
  await helper.goto(`${BASE}/login.html?testKey=${encodeURIComponent(TEST_KEY)}`);
  await helper.fill('#su-user', `${NAME}-gpu`);
  await helper.fill('#su-pass', PASSWORD);
  await helper.click('#signup-form button[type=submit]');
  await helper.waitForURL(/chat\.html/);
  const token = await helper.evaluate(async () => (await (await fetch('/api/tokens', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'demo' }),
  })).json()).token);
  provider = new MockProvider({ url: BASE, token, testKey: TEST_KEY, tokens: 120, delayMs: 55, decodeTps: 26 });
  await provider.connect();
  console.log('mock provider online');
}

try {
  // 1 — the landing page, scrolled slowly
  await page.goto(BASE);
  await pause(page, 2600);
  await page.evaluate(() => window.scrollTo({ top: 620, behavior: 'smooth' }));
  await pause(page, 2200);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await pause(page, 1200);

  // 2 — sign up, no email address
  await page.goto(`${BASE}/login.html${TEST_KEY ? `?testKey=${encodeURIComponent(TEST_KEY)}` : ''}`);
  await pause(page, 1200);
  await page.type('#su-user', NAME, { delay: 90 });
  await page.type('#su-pass', PASSWORD, { delay: 55 });
  await pause(page, 600);
  await page.click('#signup-form button[type=submit]');
  await page.waitForURL(/chat\.html/, { timeout: 30000 });
  await pause(page, 1800);

  // 3 — ask the swarm, watch it stream in and the coins being spent
  await page.type('#input', 'Explain in two sentences why a browser can run a 27B model.', { delay: 45 });
  await pause(page, 500);
  await page.click('#send');
  await page.waitForSelector('.msg.assistant .content', { timeout: 30000 });
  await pause(page, 9000);

  // 4 — the provider page: share the GPU, admission, coins landing
  await page.goto(`${BASE}/share.html${USE_MOCK && TEST_KEY ? `?provider=mock&testKey=${encodeURIComponent(TEST_KEY)}` : ''}`);
  await pause(page, 1800);
  if (USE_MOCK && TEST_KEY) {
    await page.click('#start');
    await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Online'), null, { timeout: 40000 });
    await pause(page, 4000);
    await page.evaluate(() => window.scrollTo({ top: 520, behavior: 'smooth' }));
    await pause(page, 3500);
  } else {
    await pause(page, 3000);
  }

  // 5 — the wallet: level, streak, badges, ledger
  await page.goto(`${BASE}/wallet.html`);
  await pause(page, 3000);
  await page.evaluate(() => window.scrollTo({ top: 480, behavior: 'smooth' }));
  await pause(page, 3000);

  // 6 — leaderboard to close
  await page.goto(`${BASE}/leaderboard.html`);
  await pause(page, 2600);
} finally {
  provider?.close();
  await helperCtx?.close();
  await context.close();          // flushes the video file
  await browser.close();
}

const files = (await readdir(OUT)).filter((f) => f.endsWith('.webm'));
const newest = files.map((f) => path.join(OUT, f)).sort().at(-1);
if (newest) {
  const target = path.join(OUT, 'demo.webm');
  if (newest !== target) await rename(newest, target);
  console.log(target);
}
