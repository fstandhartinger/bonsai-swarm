/**
 * Share this machine's GPU.
 *
 * The model can only run in a browser (WebGPU), so this starts a real Chrome pointed at
 * the provider page, signed in with the stored API token, with the three switches that
 * stop Chrome from throttling a window that is in the background - the exact failure
 * mode seen during the evaluation, where loading stalled in an occluded tab.
 *
 * The browser gets its own profile directory so the 5.9 GB model stays cached between
 * runs and nothing touches your normal Chrome profile.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { configDir } from './config.js';

const CANDIDATES = {
  linux: [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
    '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
};

export function findChrome(explicit = null) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`No browser at ${explicit}`);
    return explicit;
  }
  if (process.env.BONSAI_SWARM_CHROME) return findChrome(process.env.BONSAI_SWARM_CHROME);
  for (const candidate of CANDIDATES[process.platform] || []) {
    if (existsSync(candidate)) return candidate;
  }
  // Playwright's bundled Chromium, when it happens to be installed.
  const pw = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (existsSync(pw)) {
    for (const dir of readdirSync(pw).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
      for (const rel of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
        const full = path.join(pw, dir, rel);
        if (existsSync(full)) return full;
      }
    }
  }
  throw new Error(
    'No Chrome, Chromium or Edge found. Install Google Chrome (recommended for WebGPU) '
    + 'or point at one with --chrome /path/to/chrome.',
  );
}

export const CHROME_FLAGS = [
  // Without these three, Chrome throttles timers in a background or occluded window and
  // the model stalls mid-load.
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=CalculateNativeWinOcclusion',
];

/**
 * Linux Chrome usually needs to be told to use Vulkan before WebGPU shows up at all
 * (and a headless server needs the GPU blocklist ignored).
 */
export const LINUX_WEBGPU_FLAGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=vulkan',
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
];

export function buildArgs({ url, token, profileDir, extraFlags = [], override = false, autostart = true }) {
  const target = new URL('/share.html', url);
  if (override) target.searchParams.set('override', '1');
  // The user asked for `provide` on the command line, so the page does not ask again.
  if (autostart) target.searchParams.set('autostart', '1');
  // The token travels in the fragment: fragments are never sent to a server and never
  // appear in an access log.
  return [
    ...CHROME_FLAGS,
    ...(process.platform === 'linux' ? LINUX_WEBGPU_FLAGS : []),
    ...extraFlags,
    `--user-data-dir=${profileDir}`,
    '--new-window',
    `${target.toString()}#token=${encodeURIComponent(token)}`,
  ];
}

export function launchBrowser({ url, token, chromePath = null, override = false, extraFlags = [], log = console.log }) {
  const binary = findChrome(chromePath);
  const profileDir = path.join(configDir(), 'browser-profile');
  mkdirSync(profileDir, { recursive: true });
  const args = buildArgs({ url, token, profileDir, extraFlags, override });

  log(`Starting ${path.basename(binary)}…`);
  log(`Profile (keeps the model cached): ${profileDir}`);
  const child = spawn(binary, args, { stdio: 'ignore', detached: false });
  child.on('error', (err) => log(`Browser failed to start: ${err.message}`));
  return child;
}

/** Polls the network so the terminal shows what the browser is doing. */
export async function watchStatus({ url, token, log = console.log, intervalMs = 20000, signal }) {
  let lastLine = '';
  for (;;) {
    if (signal?.aborted) return;
    try {
      const [me, stats] = await Promise.all([
        fetch(`${url}/api/me`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json()),
        fetch(`${url}/api/stats`).then((r) => r.json()),
      ]);
      const mine = me.providers?.[0];
      const line = mine
        ? `${mine.state}${mine.admitted ? '' : ' (not admitted)'} · ${mine.decodeTps ? `${Number(mine.decodeTps).toFixed(1)} tok/s` : 'measuring'}`
          + ` · ${mine.jobsServed} requests · ${mine.tokensServed} tokens · ${Number(me.user.balance).toFixed(1)} AI Coins`
          + ` · network: ${stats.providersReady}/${stats.providersOnline} ready`
        : `browser not connected yet · network: ${stats.providersReady}/${stats.providersOnline} ready`;
      if (line !== lastLine) { log(`[${new Date().toLocaleTimeString()}] ${line}`); lastLine = line; }
    } catch (err) {
      log(`[status] ${err.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
