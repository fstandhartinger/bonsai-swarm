/**
 * End-to-end test against a running deployment.
 *
 *   BSW_BASE_URL=https://bonsai-swarm.app.mintapis.com \
 *   BSW_TEST_KEY=<TEST_MODE_KEY> npx playwright test tests/e2e
 *
 * Sandy has no GPU, so the volunteer side is the deterministic mock provider. It only
 * attaches when BSW_TEST_KEY matches the server's TEST_MODE_KEY, which normal users do
 * not have.
 */
import { test, expect } from '@playwright/test';
import { MockProvider } from '../mock-provider.js';

const BASE = process.env.BSW_BASE_URL || 'http://127.0.0.1:3111';
const TEST_KEY = process.env.BSW_TEST_KEY || '';

const uniq = (prefix) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'e2e-password-1234';

async function signUp(page, username) {
  await page.goto(`${BASE}/login.html${TEST_KEY ? `?testKey=${encodeURIComponent(TEST_KEY)}` : ''}`);
  await page.fill('#su-user', username);
  await page.fill('#su-pass', PASSWORD);
  await page.click('#signup-form button[type=submit]');
  await page.waitForURL(/chat\.html/, { timeout: 20000 });
}

async function apiToken(page, name = 'e2e') {
  return page.evaluate(async (tokenName) => {
    const res = await fetch('/api/tokens', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: tokenName }),
    });
    return (await res.json()).token;
  }, name);
}

const balance = (page) => page.evaluate(async () => (await (await fetch('/api/me')).json()).user.balance);

test('the landing page shows live network statistics', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.locator('h1')).toContainText('Share your GPU');
  await expect(page.locator('#s-providers')).not.toHaveText('–', { timeout: 15000 });
  await expect(page.locator('a[href="/impressum.html"]').first()).toBeVisible();
});

test('anonymous sign-up grants the welcome budget', async ({ page }) => {
  await signUp(page, uniq('e2e'));
  expect(await balance(page)).toBeGreaterThan(0);
  await expect(page.locator('.wallet .num')).not.toHaveText('', { timeout: 10000 });
});

test('a chat answer is streamed from a volunteer and the AI Coins move both ways', async ({ browser }) => {
  test.skip(!TEST_KEY, 'BSW_TEST_KEY is required to attach the mock provider');

  const providerContext = await browser.newContext();
  const providerPage = await providerContext.newPage();
  const providerName = uniq('host');
  await signUp(providerPage, providerName);
  const token = await apiToken(providerPage, 'e2e-provider');
  const providerBefore = await balance(providerPage);

  const provider = new MockProvider({ url: BASE, token, testKey: TEST_KEY, tokens: 6, decodeTps: 40 });
  const admission = await provider.connect();
  expect(admission.admitted).toBe(true);

  try {
    const consumerContext = await browser.newContext();
    const consumerPage = await consumerContext.newPage();
    await signUp(consumerPage, uniq('user'));
    const consumerBefore = await balance(consumerPage);

    await consumerPage.waitForFunction(
      async () => (await (await fetch('/api/stats')).json()).providersReady > 0,
      null,
      { timeout: 20000 },
    );

    await consumerPage.fill('#input', 'Hello swarm, this is an end-to-end test.');
    await consumerPage.click('#send');

  const answer = consumerPage.locator('.msg.assistant .content').last();
    await expect(answer).toContainText('mock', { timeout: 40000 });
    await expect(consumerPage.locator('.msg.assistant .meta').last())
      .toContainText('AI Coins', { timeout: 40000 });

    const consumerAfter = await balance(consumerPage);
    expect(consumerAfter).toBeLessThan(consumerBefore);

    await expect.poll(async () => balance(providerPage), { timeout: 20000 })
      .toBeGreaterThan(providerBefore);

    // the provider's own account never sees the prompt text, only counters
    const jobs = await providerPage.evaluate(async () => (await (await fetch('/api/jobs')).json()).jobs);
    expect(jobs[0].completion_tokens).toBe(6);
    expect(JSON.stringify(jobs[0])).not.toContain('end-to-end test');

    await consumerContext.close();
  } finally {
    provider.close();
    await providerContext.close();
  }
});

test('the browser provider page runs end to end in mock mode', async ({ browser }) => {
  test.skip(!TEST_KEY, 'BSW_TEST_KEY is required for mock mode');

  const context = await browser.newContext();
  const page = await context.newPage();
  await signUp(page, uniq('sharer'));
  try {
    await page.goto(`${BASE}/share.html?provider=mock&testKey=${encodeURIComponent(TEST_KEY)}`);
    await page.click('#start');
    await expect(page.locator('#status')).toContainText('Online', { timeout: 30000 });
    await expect(page.locator('#tps')).toContainText('tok/s');
  } finally {
    await context.close();
  }
});

test('the wallet page shows level, badges and a real ledger', async ({ page }) => {
  await signUp(page, uniq('wallet'));
  await page.goto(`${BASE}/wallet.html`);
  await expect(page.locator('#level-name')).toHaveText(/Seedling|Sprout/, { timeout: 15000 });
  await expect(page.locator('#badges .badge').first()).toBeVisible();
  await expect(page.locator('#ledger tr').first()).toContainText('Welcome budget');
});

test('a signed-out visitor is sent to the sign-in page', async ({ page }) => {
  await page.goto(`${BASE}/chat.html`);
  await page.waitForURL(/login\.html/, { timeout: 15000 });
});

test('the OpenAI-compatible endpoint answers with a bearer token', async ({ page }) => {
  test.skip(!TEST_KEY, 'BSW_TEST_KEY is required to attach the mock provider');
  await signUp(page, uniq('apiuser'));
  const userToken = await apiToken(page, 'e2e-api');

  const hostContext = await page.context().browser().newContext();
  const hostPage = await hostContext.newPage();
  await signUp(hostPage, uniq('apihost'));
  const provider = new MockProvider({ url: BASE, token: await apiToken(hostPage, 'p'), testKey: TEST_KEY, tokens: 4 });
  await provider.connect();

  try {
    const res = await fetch(`${BASE}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ model: 'bonsai-swarm/ternary-bonsai-2-27b', messages: [{ role: 'user', content: 'ping' }] }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.choices[0].message.content).toContain('mock');
    expect(json.usage.completion_tokens).toBe(4);
  } finally {
    provider.close();
    await hostContext.close();
  }
});

test('with no volunteer online the chat streams a clearly labelled fallback answer', async ({ page }) => {
  const cfg = await (await fetch(`${BASE}/api/config`)).json();
  test.skip(!cfg.fallback?.enabled, 'this deployment has no fallback model configured');
  const stats = await (await fetch(`${BASE}/api/stats`)).json();
  test.skip(stats.providersReady > 0, 'a real volunteer is online, so the fallback is not the path under test');

  await signUp(page, uniq('e2efb'));
  const before = await balance(page);

  await page.fill('#input', 'In one sentence, what is a peer-to-peer network?');
  await page.click('#send');

  // The label has to be on screen, and it has to name the model that answered.
  const notice = page.locator('.fallback-note');
  await expect(notice).toBeVisible({ timeout: 60000 });
  await expect(notice).toContainText('No community GPU online right now');
  await expect(notice).toContainText('answered by a free fallback model');

  // And a real answer has to arrive under it.
  const answer = page.locator('.msg.assistant .content').last();
  await expect(answer).not.toHaveText('', { timeout: 60000 });
  await expect(page.locator('.msg.assistant .meta').last()).toContainText('free fallback model', { timeout: 60000 });

  // Flat rate, not the per-token price.
  const after = await balance(page);
  expect(before - after).toBe(cfg.fallback.coinsFlat);

  // Nothing about this may look like a volunteer's work.
  const ledger = await page.evaluate(async () => (await (await fetch('/api/ledger')).json()).entries);
  const spend = ledger.find((e) => Number(e.coins) < 0);
  expect(spend.kind).toBe('consume_fallback');
});
