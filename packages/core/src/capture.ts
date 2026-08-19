import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { decodeImage, decodePng, resizeRgba } from './pixels.js';
import { diffImages, dropTextNoise } from './diff.js';
import { figmaNodeName, traceRegions } from './trace.js';
import { analyzeLayout } from './layout.js';
import { analyzeResponsive } from './responsive.js';
import { assertViewportOk, MAX_REGIONS, MAX_WAIT_MS } from './limits.js';
import { assertTargetAllowed, type Mode } from './security.js';
import type {
  CaptureOptions,
  DesignContext,
  DiffResult,
  MultiViewportResult,
  RgbaImage,
  TextNoiseFilter,
} from './types.js';

// Design image cache: avoids re-decoding the same image across multiple captures
const designCache = new Map<string, { mtime: number; size: number; image: RgbaImage }>();

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

/** Figma node names that strongly imply text content (glyph AA noise risk). */
const TEXT_NODE_NAME = /text|label|title|price|desc|heading|body/i;

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
    textRegionThreshold,
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

  // Validate designContext before decoding (fail fast on malformed input).
  if (designContext) {
    validateDesignContext(designContext);
  }

  const design = await decodeImageWithCache(designImagePath, mode);
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

  const designImageHash = computeHash(design.data);

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
    const textNoiseFilter: TextNoiseFilter = { enabled: false, droppedRegions: [] };
    // Text anti-aliasing noise: when textRegionThreshold (a more lenient
    // pixelmatch threshold) is given, drop text-like regions whose diff
    // disappears under it — e.g. a slightly different font rendering. Figma
    // node names matching a text pattern count as extra evidence.
    if (
      textRegionThreshold !== undefined &&
      textRegionThreshold > diffThreshold &&
      regions.length > 0
    ) {
      textNoiseFilter.enabled = true;
      textNoiseFilter.threshold = textRegionThreshold;
      const droppedRegionIds = regions.map((r) => r.id);
      const { regions: filtered, dropped } = dropTextNoise(
        designPixels,
        screenshotPixels,
        regions,
        {
          textThreshold: textRegionThreshold,
          isText: designContext?.nodes?.length
            ? (region) => {
                const name = figmaNodeName(region, designContext?.nodes);
                return name != null && TEXT_NODE_NAME.test(name);
              }
            : undefined,
        },
      );
      const filteredIds = new Set(filtered.map((r) => r.id));
      for (const id of droppedRegionIds) {
        if (!filteredIds.has(id)) {
          textNoiseFilter.droppedRegions.push({
            id,
            reason: 'text anti-aliasing noise (diff disappears at textRegionThreshold)',
          });
        }
      }
      if (dropped > 0) {
        traceWarnings.push(
          `dropped ${dropped} text anti-aliasing region(s) (textRegionThreshold ${textRegionThreshold})`,
        );
      }
      regions = filtered;
    }
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

    // Phase 2: Advanced layout analysis (spacing, typography, alignment)
    let layoutAnalysis;
    if (options.analyzeLayout && regions.length > 0) {
      try {
        layoutAnalysis = await analyzeLayout(page, regions, designContext);
      } catch (error) {
        traceWarnings.push(
          `layout analysis failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Phase 3: Responsive design validation (if viewports provided)
    let responsiveAnalysis;
    if (options.validateResponsive && options.viewports && options.viewports.length > 0) {
      try {
        responsiveAnalysis = await analyzeResponsive(url, options.viewports, browser);
      } catch (error) {
        traceWarnings.push(
          `responsive analysis failed: ${error instanceof Error ? error.message : String(error)}`,
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
        designImageHash,
      },
      trace: { status: traceStatus, warnings: traceWarnings },
      repoRoot,
      ...(textNoiseFilter.enabled ? { textNoiseFilter } : {}),
      ...(layoutAnalysis ? { layoutAnalysis } : {}),
      ...(responsiveAnalysis ? { responsiveAnalysis } : {}),
    };
  } finally {
    await browser.close();
  }
}

/**
 * Capture at multiple viewports for responsive verification. Returns results
 * per viewport plus an overall status and average similarity.
 */
export async function captureAndDiffMultiViewport(
  options: CaptureOptions,
): Promise<MultiViewportResult> {
  const viewports = options.viewports;
  if (!viewports || viewports.length === 0) {
    throw new Error('viewports must be provided for multi-viewport capture');
  }

  const results: DiffResult[] = [];
  for (const vp of viewports) {
    const result = await captureAndDiff({ ...options, viewport: vp, viewports: undefined });
    results.push(result);
  }

  const allMatch = results.every((r) => r.status === 'match');
  const avgSimilarity = results.reduce((sum, r) => sum + r.similarity, 0) / results.length;

  return {
    results,
    status: allMatch ? 'match' : 'diff',
    averageSimilarity: round5(avgSimilarity),
  };
}

function computeHash(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Decode a design image with caching. Caches by path + mtime + size to avoid
 * re-decoding the same image across multiple captures. Only caches local files
 * (not URLs) since URLs can change without mtime/size changes.
 */
async function decodeImageWithCache(imagePath: string, mode: Mode): Promise<RgbaImage> {
  // Only cache local files (URLs can change without mtime/size changes)
  if (/^https?:\/\//i.test(imagePath)) {
    return decodeImage(imagePath, mode);
  }

  try {
    const stats = await stat(imagePath);
    const cacheKey = imagePath;
    const cached = designCache.get(cacheKey);

    if (cached && cached.mtime === stats.mtimeMs && cached.size === stats.size) {
      return cached.image;
    }

    const image = await decodeImage(imagePath, mode);
    designCache.set(cacheKey, {
      mtime: stats.mtimeMs,
      size: stats.size,
      image,
    });
    return image;
  } catch {
    // If stat fails, fall back to non-cached decode
    return decodeImage(imagePath, mode);
  }
}

/**
 * Validate designContext to catch common mistakes early (e.g., wrong coordinate
 * system, invalid scale). Throws on invalid input, warns on suspicious values.
 */
function validateDesignContext(ctx: DesignContext): void {
  // Validate scale
  if (ctx.scale !== undefined) {
    if (ctx.scale < 1 || ctx.scale > 3) {
      throw new Error(
        `designContext.scale must be 1, 2, or 3 (got ${ctx.scale}). ` +
          `Figma exports at 1x/2x/3x scale — use the same scale you exported at.`,
      );
    }
    if (!Number.isInteger(ctx.scale)) {
      throw new Error(`designContext.scale must be an integer (got ${ctx.scale})`);
    }
  }

  // Validate tokens
  if (ctx.tokens) {
    if (!Array.isArray(ctx.tokens)) {
      throw new Error('designContext.tokens must be an array');
    }
    for (const token of ctx.tokens) {
      if (!token.name || typeof token.name !== 'string') {
        throw new Error('Each token must have a string "name" field');
      }
      if (!token.value || typeof token.value !== 'string') {
        throw new Error(`Token "${token.name}" must have a string "value" field`);
      }
      if (!['color', 'spacing', 'radius', 'font'].includes(token.kind)) {
        throw new Error(
          `Token "${token.name}" has invalid kind "${token.kind}" — expected color, spacing, radius, or font`,
        );
      }
    }
  }

  // Validate nodes
  if (ctx.nodes) {
    if (!Array.isArray(ctx.nodes)) {
      throw new Error('designContext.nodes must be an array');
    }
    for (const node of ctx.nodes) {
      if (!node.name || typeof node.name !== 'string') {
        throw new Error('Each node must have a string "name" field');
      }
      if (typeof node.x !== 'number' || typeof node.y !== 'number') {
        throw new Error(`Node "${node.name}" must have numeric x, y coordinates`);
      }
      if (typeof node.width !== 'number' || typeof node.height !== 'number') {
        throw new Error(`Node "${node.name}" must have numeric width, height`);
      }
      if (node.width <= 0 || node.height <= 0) {
        throw new Error(
          `Node "${node.name}" has invalid dimensions ${node.width}x${node.height} — must be positive`,
        );
      }
      if (node.x < 0 || node.y < 0) {
        throw new Error(
          `Node "${node.name}" has negative coordinates (${node.x}, ${node.y}) — ` +
            `nodes should be in design-image space (top-left = 0,0)`,
        );
      }
    }
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
