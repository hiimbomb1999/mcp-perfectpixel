import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const fixtureDir = path.join(here, 'fixtures');
const designHtml = path.join(fixtureDir, 'design.html');
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
    figmaNode?: string;
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
      patches: Array<{
        file: string;
        line: number;
        column: number;
        property: string;
        current: string;
        suggested: string;
        value: string;
        figmaToken?: { name: string; value: string; kind: string };
      }>;
      notes: string[];
    } | null;
  }>;
  capture: {
    viewport: { width: number; height: number };
    viewportSource: string;
    locale: string;
    timezoneId: string;
    reducedMotion: boolean;
    animationsDisabled: boolean;
    fontsWaited: boolean;
  };
  artifacts: {
    screenshotPath: string;
    diffImagePath: string;
    designImagePath: string;
    designImageHash?: string;
  };
  trace: {
    status: string;
    warnings: string[];
  };
  textNoiseFilter?: {
    enabled: boolean;
    threshold?: number;
    droppedRegions: Array<{ id: number; reason: string }>;
  };
}

let client: Client;
let designPng: string;
const tmpDirs: string[] = [];

function newTmpDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `mcp-perfectpixel-figma-${Math.random().toString(36).slice(2, 8)}`,
  );
  tmpDirs.push(dir);
  return dir;
}

async function renderDesign(): Promise<string> {
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

// Create a minimal HTML file for testing
async function createMinimalHtml(): Promise<string> {
  const html = '<!DOCTYPE html><html><body></body></html>';
  const dir = newTmpDir();
  await mkdir(dir, { recursive: true });
  const outPath = path.join(dir, 'page.html');
  await writeFile(outPath, html);
  return `file://${outPath}`;
}

async function callCapture(
  url: string,
  designImagePath: string,
  overrides: Record<string, unknown> = {},
): Promise<CaptureResult> {
  const response = await client.callTool({
    name: 'capture_and_diff',
    arguments: {
      url,
      designImagePath,
      outputDir: newTmpDir(),
      ...overrides,
    },
  });

  if (response.isError) {
    const text = response.content.find((c) => c.type === 'text');
    const error = text ? (text as { type: 'text'; text: string }).text : 'Unknown error';
    throw new Error(error);
  }

  expect(response.structuredContent).toBeDefined();
  const text = response.content.find((c) => c.type === 'text');
  expect(text).toBeDefined();
  const parsed = JSON.parse((text as { type: 'text'; text: string }).text) as CaptureResult;
  expect((response.structuredContent as { status?: string }).status).toBe(parsed.status);
  return parsed;
}

beforeAll(async () => {
  if (!existsSync(serverEntry)) {
    throw new Error(`Server not built: ${serverEntry}. Run "pnpm build" before "pnpm test".`);
  }
  designPng = await renderDesign();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...process.env },
  });
  client = new Client({ name: 'mcp-perfectpixel-figma-e2e', version: '0.1.0' });
  await client.connect(transport);
}, 120_000);

afterAll(async () => {
  await client?.close();
  await Promise.all(
    tmpDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
});

describe('Figma integration', () => {
  describe('designContext.scale', () => {
    it('rejects invalid scale values', async () => {
      const pageUrl = await createMinimalHtml();

      await expect(
        callCapture(pageUrl, designPng, {
          designContext: { scale: 4 },
        }),
      ).rejects.toThrow(/scale must be 1, 2, or 3/);

      await expect(
        callCapture(pageUrl, designPng, {
          designContext: { scale: 1.5 },
        }),
      ).rejects.toThrow(/scale must be an integer/);
    });
  });

  describe('designContext.tokens', () => {
    it('validates token format', async () => {
      const pageUrl = await createMinimalHtml();

      await expect(
        callCapture(pageUrl, designPng, {
          designContext: {
            tokens: [{ name: '', value: '#fff', kind: 'color' }],
          },
        }),
      ).rejects.toThrow(/Each token must have a string.*name.*field/);

      await expect(
        callCapture(pageUrl, designPng, {
          designContext: {
            tokens: [{ name: 'test', value: '', kind: 'color' }],
          },
        }),
      ).rejects.toThrow(/Token.*test.*must have a string.*value.*field/);

      await expect(
        callCapture(pageUrl, designPng, {
          designContext: {
            tokens: [{ name: 'test', value: '#fff', kind: 'invalid' }],
          },
        }),
      ).rejects.toThrow(
        /Invalid enum value.*Expected.*color.*spacing.*radius.*font.*received.*invalid/,
      );
    });
  });

  describe('designContext.nodes', () => {
    it('validates node format', async () => {
      const pageUrl = await createMinimalHtml();

      await expect(
        callCapture(pageUrl, designPng, {
          designContext: {
            nodes: [{ name: '', x: 0, y: 0, width: 100, height: 100 }],
          },
        }),
      ).rejects.toThrow(/Each node must have a string.*name.*field/);

      await expect(
        callCapture(pageUrl, designPng, {
          designContext: {
            nodes: [{ name: 'test', x: -10, y: 0, width: 100, height: 100 }],
          },
        }),
      ).rejects.toThrow(/Node.*test.*has negative coordinates/);

      await expect(
        callCapture(pageUrl, designPng, {
          designContext: {
            nodes: [{ name: 'test', x: 0, y: 0, width: 0, height: 100 }],
          },
        }),
      ).rejects.toThrow(/Node.*test.*has invalid dimensions/);
    });
  });

  describe('designImageHash', () => {
    it('includes SHA-256 hash in artifacts', async () => {
      const pageUrl = await createMinimalHtml();

      const result = await callCapture(pageUrl, designPng);

      expect(result.artifacts.designImageHash).toBeDefined();
      expect(result.artifacts.designImageHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('hash is consistent across re-captures', async () => {
      const pageUrl = await createMinimalHtml();

      const result1 = await callCapture(pageUrl, designPng);
      const result2 = await callCapture(pageUrl, designPng);

      expect(result1.artifacts.designImageHash).toBe(result2.artifacts.designImageHash);
    });
  });

  describe('textNoiseFilter', () => {
    it('includes structured text noise filter results', async () => {
      const pageUrl = await createMinimalHtml();

      const result = await callCapture(pageUrl, designPng, {
        textRegionThreshold: 0.2,
      });

      // Text noise filter should be enabled
      expect(result.textNoiseFilter).toBeDefined();
      expect(result.textNoiseFilter!.enabled).toBe(true);
      expect(result.textNoiseFilter!.threshold).toBe(0.2);
      expect(Array.isArray(result.textNoiseFilter!.droppedRegions)).toBe(true);
    });
  });
});
