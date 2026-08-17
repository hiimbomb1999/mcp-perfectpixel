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

function segment(genCol: number, src: number, line: number, col: number): string {
  return vlq(genCol) + vlq(src) + vlq(line) + vlq(col);
}

const PAGE_CSS = [
  '.header { position: absolute; top: 0; left: 0; width: 800px; height: 80px; background-color: #1e40af; }',
  '.button { position: absolute; top: 10px; left: 10px; width: 120px; height: 36px; background-color: #dc2626; }',
  '.card { position: absolute; top: 120px; left: 50px; width: 200px; height: 120px; background-color: #ffffff; border: 2px solid #e2e8f0; }',
  'body { margin: 0; }',
].join('\n');

const DESIGN_CSS = PAGE_CSS.replace('#1e40af', '#2563eb').replace('#dc2626', '#16a34a');

function pageHtml(mysteryColor: string, cssHref: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>map-page</title>
  <link rel="stylesheet" href="${cssHref}" />
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; }
    body { background: #f8fafc; }
  </style>
</head>
<body>
  <div class="header"></div>
  <div class="card"><div class="button"></div></div>
  <span class="mystery" style="position:absolute;left:300px;top:300px;display:block;width:40px;height:40px;background-color:${mysteryColor}"></span>
</body>
</html>
`;
}

let dir: string;
let designPng: string;
let result: DiffResult;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-perfectpixel-trace-'));
  await writeFile(path.join(dir, 'design.css'), DESIGN_CSS);

  // The page CSS carries a source map mapping each rule start back to
  // "src/_page.scss". Header rule -> orig line 2, col 2; button rule -> line 4, col 0.
  const map = {
    version: 3,
    sources: ['src/_page.scss'],
    names: [],
    mappings: `${segment(0, 0, 2, 2)};${segment(0, 0, 2, 0)}`,
  };
  const mapB64 = Buffer.from(JSON.stringify(map)).toString('base64');
  const pageCss = `${PAGE_CSS}\n/*# sourceMappingURL=data:application/json;base64,${mapB64} */`;
  await writeFile(path.join(dir, 'page.css'), pageCss);

  await writeFile(path.join(dir, 'design.html'), pageHtml('#6d28d9', 'design.css'));
  await writeFile(path.join(dir, 'page.html'), pageHtml('#10b981', 'page.css'));

  // Design tokens the "project" defines — patch suggestions should prefer these.
  await writeFile(
    path.join(dir, 'tokens.css'),
    ':root {\n  --color-success: #16a34a;\n  --color-brand: #2563eb;\n}\n',
  );

  // Render the design fixture with the same deterministic settings as capture.
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

function regionOf(result: DiffResult, className: string) {
  return result.regions.find((r) => r.source?.element.classes.includes(className));
}

describe('region source tracing (CSS source maps, then text search, then DOM evidence)', () => {
  it('resolves rules through CSS source maps with high confidence', () => {
    expect(result.status).toBe('diff');
    expect(result.regions).toHaveLength(3);

    const button = regionOf(result, 'button')!;
    expect(button.source!.confidence).toBe('high');
    const buttonRule = button.source!.rules.find((r) => r.selector === '.button')!;
    expect(buttonRule.source).toEqual({
      file: 'src/_page.scss',
      line: 5, // orig line 4 (0-based) + 1
      column: 3, // orig col 2 + 1
      via: 'source-map',
      gitignored: false,
    });
    expect(buttonRule.properties).toContain('background-color');
    expect(buttonRule.declared['background-color']).toBe('#dc2626');
    expect(buttonRule.applies).toBe(true);

    const header = regionOf(result, 'header')!;
    const headerRule = header.source!.rules.find((r) => r.selector === '.header')!;
    expect(headerRule.source).toMatchObject({
      file: 'src/_page.scss',
      line: 3,
      column: 3,
      via: 'source-map',
    });
    expect(headerRule.declared['background-color']).toBe('#1e40af');
  });

  it('attaches element + computed-style evidence', () => {
    const button = regionOf(result, 'button')!;
    expect(button.source!.element).toMatchObject({
      tag: 'div',
      id: null,
      classes: ['button'],
    });
    expect(button.source!.element.computedStyle['background-color']).toBe('rgb(220, 38, 38)');
  });

  it('suggests minimal patches anchored to the rule source, preferring tokens', () => {
    const button = regionOf(result, 'button')!;
    const buttonPatches = button.source!.patches.filter((p) => p.property === 'background-color');
    expect(buttonPatches).toHaveLength(1);
    expect(buttonPatches[0]).toMatchObject({
      file: 'src/_page.scss',
      line: 5,
      column: 3,
      property: 'background-color',
      current: '#dc2626', // what the page declares
      suggested: 'var(--color-success)', // token, not a new hardcoded value
      value: '#16a34a', // what the design image shows
      confidence: 'high',
    });
    expect(buttonPatches[0]!.token).toMatchObject({
      name: '--color-success',
      reference: 'var(--color-success)',
      value: '#16a34a',
      kind: 'css-variable',
    });

    const header = regionOf(result, 'header')!;
    const headerPatches = header.source!.patches.filter((p) => p.property === 'background-color');
    expect(headerPatches[0]!.suggested).toBe('var(--color-brand)');
    expect(headerPatches[0]!.current).toBe('#1e40af');
  });

  it('returns DOM evidence with low confidence when nothing resolves', () => {
    const mystery = regionOf(result, 'mystery')!;
    // The mystery span is styled inline — no CSS rule, no text-search match.
    expect(mystery.source!.rules).toEqual([]);
    expect(mystery.source!.patches).toEqual([]);
    expect(mystery.source!.confidence).toBe('low');
    expect(mystery.source!.element.classes).toContain('mystery');
    expect(mystery.source!.element.computedStyle['background-color']).toBe('rgb(16, 185, 129)');
  });

  it('exposes the repoRoot used for tracing', () => {
    expect(result.repoRoot).toBe(dir);
  });
});
