import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { decodeImage, decodePng, resizeRgba } from './pixels.js';
import { diffImages } from './diff.js';
import type { CaptureOptions, DiffResult, RgbaImage } from './types.js';

/**
 * Kills animations/transitions and stabilizes rendering so re-captures are
 * pixel-identical. Injected before any page script runs.
 */
const DETERMINISM_SCRIPT = `
  const style = document.createElement('style');
  style.id = 'mcp-perfectpixel-determinism';
  style.textContent = [
    '*, *::before, *::after {',
    '  animation: none !important;',
    '  animation-duration: 0s !important;',
    '  animation-delay: 0s !important;',
    '  transition: none !important;',
    '  transition-duration: 0s !important;',
    '  transition-delay: 0s !important;',
    '  scroll-behavior: auto !important;',
    '  caret-color: transparent !important;',
    '}',
  ].join('\\n');
  document.documentElement.appendChild(style);
`;

const LAUNCH_ARGS = ['--lang=en-US', '--force-prefers-reduced-motion', '--disable-dev-shm-usage'];

/**
 * Deterministically screenshot `url` and diff it against the static design
 * image at `designImagePath`. Capture is pinned to en-US locale, UTC timezone,
 * light color scheme, reduced motion, and animations disabled; fonts are fully
 * loaded before the screenshot is taken.
 */
export async function captureAndDiff(options: CaptureOptions): Promise<DiffResult> {
  const {
    url,
    designImagePath,
    outputDir,
    waitForSelector,
    waitMs,
    diffThreshold = 0.1,
    matchThreshold = 0.001,
    navigationTimeoutMs = 30_000,
  } = options;

  const design = await decodeImage(designImagePath);
  const viewport = options.viewport ?? { width: design.width, height: design.height };
  const designPixels: RgbaImage =
    viewport.width === design.width && viewport.height === design.height
      ? design
      : resizeRgba(design, viewport.width, viewport.height);

  const outDir =
    outputDir ??
    path.join(
      os.tmpdir(),
      'mcp-perfectpixel',
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
  await mkdir(outDir, { recursive: true });

  const started = performance.now();
  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  try {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'light',
      reducedMotion: 'reduce',
    });
    await context.addInitScript(DETERMINISM_SCRIPT);

    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: navigationTimeoutMs });
    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: 10_000 });
    }
    // Block until all web fonts are loaded — text must not reflow after capture.
    await page.evaluate(() => document.fonts.ready.then(() => true));
    if (waitMs && waitMs > 0) {
      await page.waitForTimeout(waitMs);
    }
    const screenshot = await page.screenshot({ type: 'png', animations: 'disabled' });
    const durationMs = performance.now() - started;

    const screenshotPixels = decodePng(screenshot);
    const analysis = diffImages(designPixels, screenshotPixels, { threshold: diffThreshold });

    const baseName = sanitize(url);
    const screenshotPath = path.join(outDir, `${baseName}-screenshot.png`);
    const diffImagePath = path.join(outDir, `${baseName}-diff.png`);
    await writeFile(screenshotPath, screenshot);
    await writeFile(diffImagePath, encodePng(analysis.diffImage, viewport.width, viewport.height));

    return {
      status: analysis.diffRatio <= matchThreshold ? 'match' : 'diff',
      similarity: 1 - analysis.diffRatio,
      diffPixelCount: analysis.diffPixelCount,
      totalPixelCount: analysis.totalPixelCount,
      diffRatio: analysis.diffRatio,
      regions: analysis.regions,
      capture: {
        url,
        viewport: { width: viewport.width, height: viewport.height },
        viewportSource: options.viewport ? 'provided' : 'design',
        locale: 'en-US',
        timezoneId: 'UTC',
        reducedMotion: true,
        animationsDisabled: true,
        fontsWaited: true,
        durationMs: Math.round(durationMs),
      },
      artifacts: {
        screenshotPath,
        diffImagePath,
        designImagePath: path.resolve(designImagePath),
      },
    };
  } finally {
    await browser.close();
  }
}

function encodePng(rgba: Buffer, width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    if (rgba[o + 3]! > 0) {
      // Diff pixel: keep the highlight color, fully opaque.
      png.data[o] = rgba[o]!;
      png.data[o + 1] = rgba[o + 1]!;
      png.data[o + 2] = rgba[o + 2]!;
    } else {
      // Non-diff: neutral gray background.
      png.data[o] = 245;
      png.data[o + 1] = 245;
      png.data[o + 2] = 245;
    }
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

function sanitize(url: string): string {
  return (
    url
      .replace(/^[a-z]+:\/\//i, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'page'
  );
}
