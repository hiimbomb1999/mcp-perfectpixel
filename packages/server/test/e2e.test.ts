import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, 'fixtures');
const designHtml = path.join(fixtureDir, 'design.html');
const pageHtml = path.join(fixtureDir, 'page.html');
const serverEntry = path.resolve(here, '../dist/index.js');

const VIEWPORT = { width: 800, height: 600 };
const LAUNCH_ARGS = ['--lang=en-US', '--force-prefers-reduced-motion', '--disable-dev-shm-usage'];

interface CaptureResult {
  status: 'match' | 'diff';
  similarity: number;
  diffPixelCount: number;
  totalPixelCount: number;
  diffRatio: number;
  regions: Array<{
    id: number;
    x: number;
    y: number;
    width: number;
    height: number;
    pixelCount: number;
    severity: string;
    score: number;
    source: {
      element: { tag: string; classes: string[]; computedStyle: Record<string, string> };
      rules: Array<{
        selector: string;
        properties: string[];
        source: {
          file: string;
          line: number;
          column: number;
          via: string;
          gitignored: boolean;
        } | null;
        confidence: string;
      }>;
      confidence: string;
    } | null;
  }>;
  capture: {
    locale: string;
    timezoneId: string;
    viewportSource: string;
    reducedMotion: boolean;
    animationsDisabled: boolean;
    fontsWaited: boolean;
  };
  artifacts: { screenshotPath: string; diffImagePath: string; designImagePath: string };
}

let client: Client;
let designPng: string;
const tmpDirs: string[] = [];

function newTmpDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `mcp-perfectpixel-e2e-${Math.random().toString(36).slice(2, 8)}`,
  );
  tmpDirs.push(dir);
  return dir;
}

async function renderDesign(): Promise<string> {
  // Render the design fixture with the same deterministic settings the server uses,
  // so the "match" case is pixel-identical.
  const out = path.join(newTmpDir(), 'design.png');
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
    await page.goto(pathToFileURL(designHtml).href, { waitUntil: 'networkidle' });
    await page.screenshot({ path: out, type: 'png', animations: 'disabled' });
    await context.close();
  } finally {
    await browser.close();
  }
  return out;
}

async function callCapture(
  url: string,
  overrides: Record<string, unknown> = {},
): Promise<CaptureResult> {
  const response = await client.callTool({
    name: 'capture_and_diff',
    arguments: {
      url,
      designImagePath: designPng,
      outputDir: newTmpDir(),
      ...overrides,
    },
  });
  expect(response.isError).toBeFalsy();
  const text = response.content.find((c) => c.type === 'text');
  expect(text).toBeDefined();
  return JSON.parse((text as { type: 'text'; text: string }).text) as CaptureResult;
}

beforeAll(async () => {
  if (!existsSync(serverEntry)) {
    throw new Error(`Server not built: ${serverEntry}. Run "pnpm build" before "pnpm test".`);
  }
  designPng = await renderDesign();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    // The SDK only inherits an env allowlist by default; the server needs the
    // full environment (e.g. PLAYWRIGHT_BROWSERS_PATH when browsers live outside
    // the default cache).
    env: { ...process.env },
  });
  client = new Client({ name: 'mcp-perfectpixel-e2e', version: '0.1.0' });
  await client.connect(transport);
}, 120_000);

afterAll(async () => {
  await client?.close();
  await Promise.all(
    tmpDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
});

describe('mcp-perfectpixel e2e (stdio -> server -> capture -> diff)', () => {
  it('diffs a live page against the design and returns grouped regions with severity', async () => {
    const result = await callCapture(pathToFileURL(pageHtml).href);

    expect(result.status).toBe('diff');
    expect(result.similarity).toBeLessThan(1);
    expect(result.diffRatio).toBeGreaterThan(0);
    expect(result.diffPixelCount).toBeGreaterThan(0);
    expect(result.totalPixelCount).toBe(VIEWPORT.width * VIEWPORT.height);

    // Two controlled changes: a strong button color change and a subtle header change.
    expect(result.regions).toHaveLength(2);

    const button = result.regions.find((r) => r.x >= 50 && r.x <= 70 && r.y >= 120 && r.y <= 140);
    expect(button).toBeDefined();
    expect(button!.severity).toBe('high');
    expect(button!.width).toBeGreaterThan(110);
    expect(button!.height).toBeGreaterThan(30);
    expect(button!.pixelCount).toBeGreaterThan(3800);

    const header = result.regions.find((r) => r.x <= 5 && r.y <= 5);
    expect(header).toBeDefined();
    expect(header!.severity).toBe('medium');
    expect(header!.width).toBeGreaterThan(790);
    expect(header!.height).toBeGreaterThan(70);

    // Source tracing through the MCP server: the fixture pages have no source
    // maps, so the .button rule resolves via gitignore-aware text search
    // against the server cwd (the repo root) -> medium confidence.
    expect(button!.source).not.toBeNull();
    expect(button!.source!.element.classes).toContain('button');
    const buttonRule = button!.source!.rules.find((r) => r.selector === '.button');
    expect(buttonRule).toBeDefined();
    expect(buttonRule!.confidence).toBe('medium');
    expect(buttonRule!.source!.via).toBe('text-search');
    expect(buttonRule!.source!.gitignored).toBe(false);
    // The match is in a non-ignored file of the repo (could be the fixture
    // itself or any source file containing the selector).
    expect(buttonRule!.source!.line).toBeGreaterThan(0);
    expect(buttonRule!.source!.file).not.toMatch(/^\.\.\//);

    // Deterministic capture claims.
    expect(result.capture.locale).toBe('en-US');
    expect(result.capture.timezoneId).toBe('UTC');
    expect(result.capture.viewportSource).toBe('design');
    expect(result.capture.reducedMotion).toBe(true);
    expect(result.capture.animationsDisabled).toBe(true);
    expect(result.capture.fontsWaited).toBe(true);

    // Artifacts are written to disk.
    expect(existsSync(result.artifacts.screenshotPath)).toBe(true);
    expect(existsSync(result.artifacts.diffImagePath)).toBe(true);
  });

  it('matches pixel-identically when the page equals the design', async () => {
    const result = await callCapture(pathToFileURL(designHtml).href);
    expect(result.status).toBe('match');
    expect(result.similarity).toBe(1);
    expect(result.diffPixelCount).toBe(0);
    expect(result.regions).toEqual([]);
  });

  it('produces byte-identical screenshots across re-captures', async () => {
    const url = pathToFileURL(pageHtml).href;
    const first = await callCapture(url);
    const second = await callCapture(url);
    const [a, b] = await Promise.all([
      readFile(first.artifacts.screenshotPath),
      readFile(second.artifacts.screenshotPath),
    ]);
    expect(a.equals(b)).toBe(true);
  });

  it('supports an explicit viewport by resizing the design image', async () => {
    const result = await callCapture(pathToFileURL(pageHtml).href, {
      viewport: { width: 400, height: 300 },
    });
    expect(result.capture.viewportSource).toBe('provided');
    expect(result.totalPixelCount).toBe(400 * 300);
    expect(result.regions.length).toBeGreaterThanOrEqual(1);
  });

  it('returns an error result for an invalid URL', async () => {
    let failed = false;
    try {
      const response = await client.callTool({
        name: 'capture_and_diff',
        arguments: { url: 'not-a-url', designImagePath: designPng },
      });
      failed = response.isError === true;
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});
