/**
 * Proof-of-life screenshot: the live site, nobody online, a labelled fallback answer.
 *   BSW_TEST_KEY=<TEST_MODE_KEY> node scripts/shot-fallback.mjs <out.png> [baseUrl]
 * The test key only skips the per-connection signup limit for a throwaway account.
 */
import { chromium } from '@playwright/test';

const out = process.argv[2] || 'fallback-live.png';
const BASE = process.argv[3] || process.env.BSW_BASE_URL || 'https://bonsai-swarm.app.mintapis.com';
const KEY = process.env.BSW_TEST_KEY || '';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
try {
  await page.goto(`${BASE}/login.html${KEY ? `?testKey=${encodeURIComponent(KEY)}` : ''}`);
  await page.fill('#su-user', `shot${Date.now().toString(36)}`);
  await page.fill('#su-pass', 'e2e-password-1234');
  await page.click('#signup-form button[type=submit]');
  await page.waitForURL(/chat\.html/, { timeout: 20000 });

  await page.fill('#input', 'In one sentence, what is BitTorrent for inference?');
  await page.click('#send');
  await page.waitForSelector('.fallback-note', { timeout: 60000 });
  await page.waitForFunction(() => {
    const m = document.querySelectorAll('.msg.assistant .meta');
    return m.length && /AI Coins/.test(m[m.length - 1].textContent);
  }, { timeout: 60000 });

  await page.screenshot({ path: out });
  console.log('notice:', (await page.locator('.fallback-note').first().textContent()).trim());
  console.log('meta  :', (await page.locator('.msg.assistant .meta').last().textContent()).trim());
} finally {
  await browser.close();
}
