/**
 * Screenshots of the real app for design review and for the launch video.
 *
 *   node scripts/shots.mjs [baseUrl] [outDir]
 *
 * Needs BSW_TEST_KEY so the deterministic mock provider can stand in for a GPU
 * (Sandy has none). Nothing here is reachable for a normal visitor.
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { MockProvider } from '../tests/mock-provider.js';

const BASE = process.argv[2] || process.env.BSW_BASE_URL || 'http://127.0.0.1:3111';
const OUT = process.argv[3] || '/tmp/bsw-shots';
const TEST_KEY = process.env.BSW_TEST_KEY || '';
const PASSWORD = 'screenshot-password-123';
const uniq = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();

async function signUp(page, username) {
  await page.goto(`${BASE}/login.html${TEST_KEY ? `?testKey=${encodeURIComponent(TEST_KEY)}` : ''}`);
  await page.fill('#su-user', username);
  await page.fill('#su-pass', PASSWORD);
  await page.click('#signup-form button[type=submit]');
  await page.waitForURL(/chat\.html/, { timeout: 30000 });
}

const shot = async (page, name) => {
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log(`  ${name}.png`);
};

// a provider so the numbers on screen are real
let provider = null;
let host = null;
if (TEST_KEY) {
  host = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const hostPage = await host.newPage();
  await signUp(hostPage, uniq('shot-host'));
  const token = await hostPage.evaluate(async () => (await (await fetch('/api/tokens', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'shots' }),
  })).json()).token);
  provider = new MockProvider({ url: BASE, token, testKey: TEST_KEY, tokens: 90, delayMs: 45, decodeTps: 34 });
  await provider.connect();
  console.log('mock provider online');
}

for (const theme of ['dark', 'light']) {
  for (const [label, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.addInitScript((t) => localStorage.setItem('bsw-theme', t), theme);
    const tag = `${theme}-${label}`;

    await page.goto(BASE);
    await shot(page, `01-landing-${tag}`);

    await signUp(page, uniq('shot'));
    await page.fill('#input', 'Write a haiku about idle graphics cards.');
    await page.click('#send');
    await page.waitForSelector('.msg.assistant .content', { timeout: 30000 });
    await page.waitForTimeout(2500);
    await shot(page, `02-chat-${tag}`);

    await page.goto(`${BASE}/share.html${TEST_KEY ? `?provider=mock&testKey=${encodeURIComponent(TEST_KEY)}` : ''}`);
    if (TEST_KEY) {
      await page.click('#start');
      await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Online'), null, { timeout: 30000 });
      await page.waitForTimeout(1500);
    }
    await shot(page, `03-share-${tag}`);
    await page.evaluate(() => window.scrollBy(0, 620));
    await shot(page, `04-share-badges-${tag}`);

    await page.goto(`${BASE}/wallet.html`);
    await page.waitForTimeout(1500);
    await shot(page, `05-wallet-${tag}`);

    await page.goto(`${BASE}/leaderboard.html`);
    await shot(page, `06-leaderboard-${tag}`);

    await page.goto(`${BASE}/coins.html`);
    await shot(page, `07-coins-${tag}`);

    await ctx.close();
  }
}

provider?.close();
await host?.close();
await browser.close();
console.log(`screenshots in ${OUT}`);
