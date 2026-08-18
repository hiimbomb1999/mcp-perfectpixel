import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { decodeImage, decodePng, resizeRgba } from './pixels.js';
import { diffImages } from './diff.js';
import { traceRegions } from './trace.js';
import { assertViewportOk, MAX_REGIONS, MAX_WAIT_MS } from './limits.js';
import { assertTargetAllowed } from './security.js';
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
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const trace = options.trace ?? true;
  const mode = options.mode ?? 'local';
  const computedStyle = options.computedStyle ?? 'minimal';
  const platform = options.platform ?? 'auto';
  const designContext = options.designContext;
  if (mode === 'hosted' && options.repoRoot === undefined) {
    throw new Error('repoRoot must be provided explicitly in hosted mode');
  }
  if (waitMs !== undefined && waitMs > MAX_WAIT_MS) {
    throw new Error(`waitMs ${waitMs} exceeds the maximum of ${MAX_WAIT_MS}`);
  }

  // Trust boundary: validate every target before touching it.
  assertTargetAllowed(url, mode, 'page URL');
  assertTargetAllowed(designImagePath, mode, 'design image');

  const design = await decodeImage(designImagePath, mode);
  assertViewportOk(design.width, design.height, 'design image');
  const viewport = deriveViewport(
    design.width,
    design.height,
    options.viewport,
    designContext?.scale,
  );
  assertViewportOk(viewport.width, viewport.height);
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
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not launch Chromium: ${message}\n` +
        'Install the browser binary with: npx playwright install chromium',
    );
  }
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

    // Cap the number of diff regions (top by score) to keep tracing bounded.
    let regions = analysis.regions;
    const traceWarnings: string[] = [];
    if (regions.length > MAX_REGIONS) {
      regions = regions.slice(0, MAX_REGIONS);
      traceWarnings.push(
        `regions truncated: ${analysis.regions.length} found, keeping the top ${MAX_REGIONS}`,
      );
    }

    // Goal 2+3: resolve each region to a DOM element, real source location, and
    // minimal patch suggestions. Best-effort — failures never fail the capture,
    // but they ARE reported through result.trace instead of being swallowed.
    let traceStatus: 'skipped' | 'ok' | 'partial' | 'failed' = 'skipped';
    let responsive: { mediaQueries: number; containerQueries: number } | undefined;
    if (trace && regions.length > 0) {
      try {
        const traced = await traceRegions(page, regions, {
          repoRoot,
          design: designPixels,
          mode,
          computedStyle,
          platform,
          designContext,
        });
        regions = traced.regions;
        traceWarnings.push(...traced.warnings);
        traceStatus = traceWarnings.length > 0 ? 'partial' : 'ok';
        responsive = traced.responsive;
      } catch (error) {
        traceStatus = 'failed';
        traceWarnings.push(
          `source tracing failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const baseName = sanitize(url);
    const screenshotPath = path.join(outDir, `${baseName}-screenshot.png`);
    const diffImagePath = path.join(outDir, `${baseName}-diff.png`);
    await writeFile(screenshotPath, screenshot);
    await writeFile(diffImagePath, encodePng(analysis.diffImage, viewport.width, viewport.height));

    // Round long floats for compact, token-friendly serialization.
    const roundedRegions = regions.map((r) => ({
      ...r,
      coverage: round5(r.coverage),
      areaRatio: round5(r.areaRatio),
      meanDelta: round5(r.meanDelta),
      maxDelta: round5(r.maxDelta),
      score: round5(r.score),
    }));
    return {
      status: analysis.diffRatio <= matchThreshold ? 'match' : 'diff',
      similarity: round5(1 - analysis.diffRatio),
      diffPixelCount: analysis.diffPixelCount,
      totalPixelCount: analysis.totalPixelCount,
      diffRatio: round5(analysis.diffRatio),
      regions: roundedRegions,
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
        ...(responsive ? { responsive } : {}),
      },
      artifacts: {
        screenshotPath,
        diffImagePath,
        // Remote design images stay URLs — never path.resolve() them.
        designImagePath: /^https?:\/\//i.test(designImagePath)
          ? designImagePath
          : path.resolve(designImagePath),
        designImageSource: designImagePath,
      },
      trace: { status: traceStatus, warnings: traceWarnings },
      repoRoot,
    };
  } finally {
    await browser.close();
  }
}

function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

/**
 * Derive the capture viewport: an explicit viewport wins; otherwise the design
 * image dimensions divided by the Figma export scale (when given) — an image
 * exported at 2x/3x is normalized back to the frame's CSS-pixel size.
 */
export function deriveViewport(
  designWidth: number,
  designHeight: number,
  viewport?: { width: number; height: number },
  scale?: number,
): { width: number; height: number } {
  if (viewport) return viewport;
  if (scale && scale > 0) {
    return {
      width: Math.round(designWidth / scale),
      height: Math.round(designHeight / scale),
    };
  }
  return { width: designWidth, height: designHeight };
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
