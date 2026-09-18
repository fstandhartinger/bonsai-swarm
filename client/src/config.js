import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_URL = process.env.BONSAI_SWARM_URL || 'https://bonsai-swarm.app.mintapis.com';

export function configDir() {
  const base = process.env.BONSAI_SWARM_HOME
    || (process.platform === 'win32'
      ? path.join(process.env.APPDATA || os.homedir(), 'bonsai-swarm')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'bonsai-swarm'));
  mkdirSync(base, { recursive: true });
  return base;
}

const configFile = () => path.join(configDir(), 'config.json');

export function readConfig() {
  const file = configFile();
  if (!existsSync(file)) return { url: DEFAULT_URL, token: null };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return { url: parsed.url || DEFAULT_URL, token: parsed.token || null };
  } catch {
    return { url: DEFAULT_URL, token: null };
  }
}

export function writeConfig(next) {
  const file = configFile();
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* windows */ }
  return file;
}

/** The API token, from the environment first so CI never needs a config file. */
export function requireAuth() {
  const cfg = readConfig();
  const token = process.env.BONSAI_SWARM_TOKEN || cfg.token;
  const url = (process.env.BONSAI_SWARM_URL || cfg.url).replace(/\/+$/, '');
  if (!token) {
    throw new Error('Not signed in. Run "bonsai-swarm login" first, or set BONSAI_SWARM_TOKEN.');
  }
  return { url, token };
}
