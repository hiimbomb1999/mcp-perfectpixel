import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { captureAndDiff } from '@mcp-perfectpixel/core';
import type { DiffResult } from '@mcp-perfectpixel/core';

const VIEWPORT = { width: 800, height: 600 };
const LAUNCH_ARGS = ['--lang=en-US', '--force-prefers-reduced-motion', '--disable-dev-shm-usage'];

const PAGE_CSS = [
  '.box { position: absolute; top: 130px; left: 60px; width: 120px; height: 36px; background-color: #b91c1c; }',
  'body { margin: 0; }',
].join('\n');
const DESIGN_CSS = PAGE_CSS.replace('#b91c1c', '#16a34a');

function html(stylesheet: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>auth</title>
  <link rel="stylesheet" href="${stylesheet}" />
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; }
    body { background: #f8fafc; }
  </style>
</head>
<body>
  <div class="box"></div>
</body>
</html>
`;
}

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let designPng: string;
let result: DiffResult;

beforeAll(async () => {
  server = createServer((req, res) => {
    // The page sets the auth cookie; the stylesheets REQUIRE it. If the trace
    // fetched stylesheets without the browser's cookies, it would get a 401.
    if (req.url === '/page') {
      res.setHeader('set-cookie', ['auth=1; Path=/']);
      res.end(html('page.css'));
      return;
    }
    if (req.url === '/design') {
      res.setHeader('set-cookie', ['auth=1; Path=/']);
      res.end(html('design.css'));
      return;
    }
    if (req.url === '/page.css' || req.url === '/design.css') {
      const authed = /(?:^|;\s*)auth=1/.test(req.headers.cookie ?? '');
      if (!authed) {
        res.statusCode = 401;
        res.end('unauthorized');
        return;
      }
      res.setHeader('content-type', 'text/css');
      res.end(req.url === '/page.css' ? PAGE_CSS : DESIGN_CSS);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Render the design with a cookie-authenticated session, like the capture.
  designPng = '/tmp/auth-design.png';
  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'light',
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/design`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: designPng, type: 'png', animations: 'disabled' });
    await context.close();
  } finally {
    await browser.close();
  }

  result = await captureAndDiff({
    url: `${baseUrl}/page`,
    designImagePath: designPng,
    repoRoot: '/tmp',
    mode: 'local',
  });
}, 120_000);

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

describe('authenticated stylesheets (session-aware fetching)', () => {
  it('loads stylesheets through the browser session (page.request)', () => {
    expect(result.status).toBe('diff');
    expect(result.regions.length).toBeGreaterThan(0);
    const source = result.regions[0]!.source;
    expect(source).not.toBeNull();
    // The .box rule exists — the stylesheet was fetched WITH the auth cookie.
    const box = source!.rules.find((r) => r.selector === '.box');
    expect(box).toBeDefined();
    expect(box!.declared['background-color']).toBe('#b91c1c');
  });
});
