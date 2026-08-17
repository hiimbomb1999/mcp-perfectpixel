import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { captureAndDiff } from '@mcp-perfectpixel/core';
import type { DiffResult } from '@mcp-perfectpixel/core';

const VIEWPORT = { width: 800, height: 600 };
const LAUNCH_ARGS = ['--lang=en-US', '--force-prefers-reduced-motion', '--disable-dev-shm-usage'];

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function vlq(value: number): string {
  let v = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += B64[digit]!;
  } while (v > 0);
  return out;
}

const PAGE_CSS = [
  '.btn { position: absolute; top: 130px; left: 60px; width: 120px; height: 36px; background-color: #dc2626; }',
  '.btn.btn-strong { background-color: #b91c1c; }',
  '@supports (display: grid) { .btn { background-color: #b91c1c; } }',
  '@supports (display: nosuch) { .btn { background-color: #00ff00; } }',
  '@media (min-width: 100000px) { .btn { background-color: #00ff00; } }',
  '@container (min-width: 100px) { .btn { background-color: #ff00ff; } }',
  '.btn { background-color: #dc2626; }',
  '.btn::after { background-color: #000000; }',
  'body { margin: 0; }',
].join('\n');

const DESIGN_CSS = PAGE_CSS.replaceAll('#dc2626', '#16a34a').replaceAll('#b91c1c', '#16a34a');

function pageHtml(cssHref: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>cascade</title>
  <link rel="stylesheet" href="${cssHref}" />
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; }
    body { background: #f8fafc; }
  </style>
</head>
<body>
  <div class="btn btn-strong"></div>
</body>
</html>
`;
}

let dir: string;
let designPng: string;
let result: DiffResult;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-perfectpixel-cascade-'));

  // Source map with sourceRoot; one segment per generated line (col 0) mapping
  // the line to itself, so every rule resolves to (its line, col 0) -> 1-based
  // (line + 1, 1).
  const lineCount = PAGE_CSS.split('\n').length;
  let prevLine = 0;
  const mappings = [];
  for (let line = 0; line < lineCount; line++) {
    mappings.push(vlq(0) + vlq(0) + vlq(line - prevLine) + vlq(0));
    prevLine = line;
  }
  const map = {
    version: 3,
    sources: ['_page.scss'],
    sourceRoot: 'src/',
    names: [],
    mappings: mappings.join(';'),
  };
  const mapB64 = Buffer.from(JSON.stringify(map)).toString('base64');
  await writeFile(
    path.join(dir, 'page.css'),
    `${PAGE_CSS}\n/*# sourceMappingURL=data:application/json;base64,${mapB64} */`,
  );
  await writeFile(path.join(dir, 'design.css'), DESIGN_CSS);
  await writeFile(path.join(dir, 'page.html'), pageHtml('page.css'));
  await writeFile(path.join(dir, 'design.html'), pageHtml('design.css'));

  designPng = path.join(dir, 'design.png');
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
    await page.goto(pathToFileURL(path.join(dir, 'design.html')).href, {
      waitUntil: 'networkidle',
    });
    await page.screenshot({ path: designPng, type: 'png', animations: 'disabled' });
    await context.close();
  } finally {
    await browser.close();
  }

  result = await captureAndDiff({
    url: pathToFileURL(path.join(dir, 'page.html')).href,
    designImagePath: designPng,
    outputDir: path.join(dir, 'out'),
    repoRoot: dir,
  });
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('cascade, conditional CSS and duplicate selectors', () => {
  it('tracks duplicate selectors with their OWN source positions', () => {
    // Two plain `.btn` rules exist (lines 0 and 6) with identical selectors;
    // each must resolve to its own line via its own offset.
    const btn = result.regions[0]!.source!;
    const plain = btn.rules.filter(
      (r) =>
        r.selector === '.btn' && r.media === null && r.container === null && r.supports === null,
    );
    expect(plain.length).toBe(2);
    const lines = plain.map((r) => r.source!.line).sort((a, b) => a - b);
    expect(lines).toEqual([1, 7]); // NOT [1, 1] — no shared counter
  });

  it('evaluates @supports and @media, and excludes rules that do not apply', () => {
    const rules = result.regions[0]!.source!.rules;
    const supportsGrid = rules.find((r) => r.supports === '(display:grid)')!;
    expect(supportsGrid.applies).toBe('yes');
    // Rule inside an unsupported @supports is dropped from the evidence.
    expect(rules.some((r) => r.supports === '(display:nosuch)')).toBe(false);
    // Rule inside a far-away @media is dropped too.
    expect(rules.some((r) => r.media === '(min-width:100000px)')).toBe(false);
  });

  it('reports @container conditions as unknown (cannot be evaluated from outside)', () => {
    const rules = result.regions[0]!.source!.rules;
    const container = rules.find((r) => r.container === '(min-width:100px)')!;
    expect(container.applies).toBe('unknown');
    // It still participates as evidence (not silently dropped).
    expect(container).toBeDefined();
  });

  it('never matches pseudo-element rules against the element', () => {
    const rules = result.regions[0]!.source!.rules;
    expect(rules.some((r) => r.selector.includes('::after'))).toBe(false);
  });

  it('patches the cascade winner: highest specificity, own source line', () => {
    const patch = result.regions[0]!.source!.patches[0]!;
    // .btn.btn-strong (0,2,0) beats every .btn (0,1,0) regardless of order.
    expect(patch.property).toBe('background-color');
    expect(patch.current).toBe('#b91c1c');
    // Its own mapped position: line 1 (0-based) -> 1-based line 2.
    expect(patch.line).toBe(2);
    expect(patch.file).toBe('src/_page.scss'); // sourceRoot applied
    expect(patch.suggested).toBe('#16a34a'); // design color, no tokens present
  });

  it('applies !important over specificity', async () => {
    // Re-run against a variant CSS where a later, lower-specificity rule
    // carries !important — it must win the cascade for the patch.
    const dir2 = await mkdtemp(path.join(os.tmpdir(), 'mcp-perfectpixel-important-'));
    const css = [
      '.btn { position: absolute; top: 130px; left: 60px; width: 120px; height: 36px; background-color: #b91c1c !important; }',
      '.btn.btn-strong { background-color: #dc2626; }',
      'body { margin: 0; }',
    ].join('\n');
    const lineCount = css.split('\n').length;
    let prevLine = 0;
    const mappings = [];
    for (let line = 0; line < lineCount; line++) {
      mappings.push(vlq(0) + vlq(0) + vlq(line - prevLine) + vlq(0));
      prevLine = line;
    }
    const mapB64 = Buffer.from(
      JSON.stringify({
        version: 3,
        sources: ['_page.scss'],
        names: [],
        mappings: mappings.join(';'),
      }),
    ).toString('base64');
    await writeFile(
      path.join(dir2, 'page.css'),
      `${css}\n/*# sourceMappingURL=data:application/json;base64,${mapB64} */`,
    );
    await writeFile(
      path.join(dir2, 'design.css'),
      css.replace('#b91c1c', '#16a34a').replace('#dc2626', '#16a34a'),
    );
    await writeFile(path.join(dir2, 'page.html'), pageHtml('page.css'));
    await writeFile(path.join(dir2, 'design.html'), pageHtml('design.css'));
    const png = path.join(dir2, 'design.png');
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
      await page.goto(pathToFileURL(path.join(dir2, 'design.html')).href, {
        waitUntil: 'networkidle',
      });
      await page.screenshot({ path: png, type: 'png', animations: 'disabled' });
      await context.close();
    } finally {
      await browser.close();
    }
    const r = await captureAndDiff({
      url: pathToFileURL(path.join(dir2, 'page.html')).href,
      designImagePath: png,
      repoRoot: dir2,
    });
    await rm(dir2, { recursive: true, force: true });
    const patch = r.regions[0]!.source!.patches[0]!;
    expect(patch.current).toBe('#b91c1c'); // the !important rule wins
    expect(patch.line).toBe(1); // its own line
  });

  it('keeps matching the right rule inside a huge (Tailwind-like) stylesheet', async () => {
    // Hundreds of unrelated rules must not drown the element's own rule:
    // candidate selectors are bucketed by the element's tag/class/id keys.
    const dir3 = await mkdtemp(path.join(os.tmpdir(), 'mcp-perfectpixel-big-'));
    const filler = Array.from(
      { length: 400 },
      (_, i) => `.c${i} { background-color: #0${i % 10}${(i % 16).toString(16)}0; }`,
    ).join('\n');
    const css = [
      filler,
      '.btn { position: absolute; top: 130px; left: 60px; width: 120px; height: 36px; background-color: #b91c1c; }',
      'body { margin: 0; }',
    ].join('\n');
    await writeFile(path.join(dir3, 'page.css'), css);
    await writeFile(path.join(dir3, 'design.css'), css.replace('#b91c1c', '#16a34a'));
    await writeFile(path.join(dir3, 'page.html'), pageHtml('page.css'));
    await writeFile(path.join(dir3, 'design.html'), pageHtml('design.css'));
    const png = path.join(dir3, 'design.png');
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
      await page.goto(pathToFileURL(path.join(dir3, 'design.html')).href, {
        waitUntil: 'networkidle',
      });
      await page.screenshot({ path: png, type: 'png', animations: 'disabled' });
      await context.close();
    } finally {
      await browser.close();
    }
    const r = await captureAndDiff({
      url: pathToFileURL(path.join(dir3, 'page.html')).href,
      designImagePath: png,
      repoRoot: dir3,
    });
    await rm(dir3, { recursive: true, force: true });
    const source = r.regions[0]!.source!;
    expect(source.rules.some((rule) => rule.selector === '.btn')).toBe(true);
    expect(source.patches[0]!.current).toBe('#b91c1c');
  });
});
