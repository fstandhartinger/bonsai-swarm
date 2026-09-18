/**
 * Does this machine actually have WebGPU in a real Chrome? Prints the adapter.
 * Used on a headless Linux box (RunPod) before trusting it as a provider.
 *
 *   node scripts/webgpu-probe.mjs [chrome path]
 */
import { chromium } from 'playwright';

const FLAGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=vulkan',
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
  '--no-sandbox',
];

const browser = await chromium.launch({ args: FLAGS, executablePath: process.argv[2] || undefined });
const page = await browser.newPage();
const info = await page.evaluate(async () => {
  if (!navigator.gpu) return { ok: false, reason: 'navigator.gpu is missing' };
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return { ok: false, reason: 'requestAdapter returned null' };
  const i = adapter.info || {};
  return {
    ok: true,
    vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description,
    maxBufferSize: adapter.limits?.maxBufferSize,
    maxStorageBufferBindingSize: adapter.limits?.maxStorageBufferBindingSize,
    features: [...(adapter.features || [])].slice(0, 12),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
process.exit(info.ok ? 0 : 1);
