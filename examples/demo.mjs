/* global URL, console, process, document */
/**
 * Quick local demo for mcp-perfectpixel's engine.
 *
 * Usage (from the repo root, after `pnpm build`):
 *
 *   node examples/demo.mjs <designImageOrHtml> <url> [repoRoot]
 *
 *   <designImageOrHtml>  PNG/JPG design image, OR an .html file which is
 *                        rendered to a PNG first (deterministic settings)
 *   <url>                http(s) URL or file:// path to the live page
 *   [repoRoot]           codebase root for source tracing (default: cwd)
 *
 * Example using the repo's own fixtures (renders the design itself):
 *
 *   node examples/demo.mjs packages/server/test/fixtures/design.html \
 *     "file://$PWD/packages/server/test/fixtures/page.html"
 *
 * Example with your own design image + live page:
 *
 *   node examples/demo.mjs ~/Downloads/frame.png https://localhost:3000
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureAndDiff } from '../packages/core/dist/index.js';

// Resolve playwright through the core package's node_modules (pnpm doesn't
// hoist to the repo root). Playwright's ESM entry re-exports chromium.
const { chromium } = await import(
  new URL('../packages/core/node_modules/playwright/index.mjs', import.meta.url)
);

const [designArg, url, repoRoot = process.cwd()] = process.argv.slice(2);

if (!designArg || !url) {
  console.error('Usage: node examples/demo.mjs <designImageOrHtml> <url> [repoRoot]');
  process.exit(1);
}

let designImagePath = designArg;
let cleanup;

if (/\.html?$/i.test(designArg)) {
  // Render the design HTML to a temp PNG with the same deterministic settings
  // the server uses (fixed locale/timezone, reduced motion, no animations).
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-perfectpixel-demo-'));
  designImagePath = path.join(dir, 'design.png');
  const browser = await chromium.launch({
    headless: true,
    args: ['--lang=en-US', '--force-prefers-reduced-motion', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 1,
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'light',
      reducedMotion: 'reduce',
    });
    await page.goto(pathToFileURL(path.resolve(designArg)).href, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready.then(() => true));
    await page.screenshot({ path: designImagePath, type: 'png', animations: 'disabled' });
  } finally {
    await browser.close();
  }
  cleanup = () => rm(dir, { recursive: true, force: true });
}

try {
  const result = await captureAndDiff({ url, designImagePath, repoRoot });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await cleanup?.();
}
