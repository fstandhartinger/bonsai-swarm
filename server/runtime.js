import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * The WebGPU runtime for Ternary Bonsai 2 lives inside one big inline ES module in the
 * Hugging Face space's index.html. That space publishes no licence, so this repository
 * does not contain a copy of it. Instead the server fetches the page, cuts out the part
 * that ends with the module's `export { ... TernaryBonsai2 ... }` statement, and serves
 * that from our own origin (same origin matters: the model weights are cached in
 * IndexedDB per origin, and a worker cannot import a cross-origin module without CORS).
 *
 * Everything after that export statement is the space's own chat UI and is dropped.
 */
const EXPORT_RE = /export\s*\{[^}]*\bTernaryBonsai2\b[^}]*\}\s*;?/;

let cache = null; // { code, etag, sha, fetchedAt, source }

export function runtimeStatus() {
  if (!cache) return { loaded: false, pinned: Boolean(config.runtime.pinnedSha) };
  return {
    loaded: true, bytes: cache.code.length, sha: cache.sha, fetchedAt: cache.fetchedAt,
    source: cache.source, pinned: Boolean(config.runtime.pinnedSha),
  };
}

function extractLibrary(html) {
  const marker = '<script type="module">';
  let best = null;
  let index = html.indexOf(marker);
  while (index !== -1) {
    const start = index + marker.length;
    const end = html.indexOf('</script>', start);
    if (end === -1) break;
    const body = html.slice(start, end);
    const match = EXPORT_RE.exec(body);
    if (match && (!best || match.index > best.length)) {
      best = body.slice(0, match.index + match[0].length);
    }
    index = html.indexOf(marker, end);
  }
  if (!best) throw new Error('could not find the TernaryBonsai2 module export in the upstream page');
  if (!best.includes('TernaryBonsai2')) throw new Error('extracted module does not mention TernaryBonsai2');
  if (best.length < 100_000) throw new Error(`extracted module looks too small (${best.length} bytes)`);
  return best;
}

async function cachePath() {
  await mkdir(config.runtime.cacheDir, { recursive: true });
  return path.join(config.runtime.cacheDir, 'bonsai2-lib.js');
}

/** Fetch + extract, falling back to the last good copy on disk when upstream is down. */
export async function loadRuntime({ force = false } = {}) {
  if (cache && !force && Date.now() - cache.fetchedAt < config.runtime.refreshMs) return cache;
  const file = await cachePath();
  try {
    const res = await fetch(config.runtime.spaceUrl, { headers: { 'user-agent': 'bonsai-swarm/0.1' } });
    if (!res.ok) throw new Error(`upstream returned ${res.status}`);
    const html = await res.text();
    const code = extractLibrary(html);
    const sha = crypto.createHash('sha256').update(code).digest('hex');
    if (config.runtime.pinnedSha && sha !== config.runtime.pinnedSha) {
      throw new Error(`upstream runtime changed (sha256 ${sha.slice(0, 16)}…, pinned `
        + `${config.runtime.pinnedSha.slice(0, 16)}…) - refusing to serve it`);
    }
    if (cache && cache.sha !== sha) {
      console.warn(`[runtime] upstream changed: ${cache.sha.slice(0, 16)}… -> ${sha.slice(0, 16)}…`);
    }
    cache = { code, sha, fetchedAt: Date.now(), source: 'upstream' };
    await writeFile(file, code, 'utf8');
    return cache;
  } catch (err) {
    try {
      const code = await readFile(file, 'utf8');
      const info = await stat(file);
      cache = {
        code,
        sha: crypto.createHash('sha256').update(code).digest('hex'),
        fetchedAt: Date.now(),
        source: `disk-cache (upstream failed: ${err.message})`,
        mtime: info.mtime,
      };
      return cache;
    } catch {
      throw err;
    }
  }
}

export function mountRuntime(app) {
  app.get('/runtime/bonsai2-lib.js', async (req, res) => {
    try {
      const { code, sha } = await loadRuntime();
      res.set({
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'public, max-age=3600',
        etag: `"${sha.slice(0, 32)}"`,
      });
      if (req.headers['if-none-match'] === `"${sha.slice(0, 32)}"`) return res.status(304).end();
      res.send(code);
    } catch (err) {
      res.status(502).type('text/plain').send(`// runtime unavailable: ${err.message}`);
    }
  });
}
