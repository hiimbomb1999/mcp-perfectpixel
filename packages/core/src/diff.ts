import pixelmatch from 'pixelmatch';
import type { DiffRegion, RgbaImage } from './types.js';
import { colorDelta } from './pixels.js';

export interface DiffAnalysis {
  diffPixelCount: number;
  totalPixelCount: number;
  diffRatio: number;
  /** RGBA raster with differing pixels highlighted (pixelmatch output). */
  diffImage: Buffer;
  regions: DiffRegion[];
}

/** Bounding boxes with a gap of <= margin px are merged into one region. */
const MERGE_MARGIN = 12;
/** Diff clusters smaller than this are treated as noise and dropped. */
const MIN_REGION_PIXELS = 4;
/** Above this many raw components, skip the O(n^2) merge pass. */
const MAX_MERGE_COMPONENTS = 400;

export interface DiffOptions {
  /** pixelmatch threshold, 0-1, smaller = more sensitive. Default 0.1. */
  threshold?: number;
  mergeMargin?: number;
  minRegionPixels?: number;
}

/**
 * Diff two same-sized RGBA rasters and group the differing pixels into
 * connected regions with severity scores — not raw noise.
 */
export function diffImages(
  design: RgbaImage,
  screenshot: RgbaImage,
  options: DiffOptions = {},
): DiffAnalysis {
  const {
    threshold = 0.1,
    mergeMargin = MERGE_MARGIN,
    minRegionPixels = MIN_REGION_PIXELS,
  } = options;
  if (design.width !== screenshot.width || design.height !== screenshot.height) {
    throw new Error(
      `Dimension mismatch: design is ${design.width}x${design.height}, screenshot is ${screenshot.width}x${screenshot.height}`,
    );
  }
  const { width, height } = design;
  const total = width * height;

  const diffImage = Buffer.alloc(total * 4);
  const diffPixelCount = pixelmatch(design.data, screenshot.data, diffImage, width, height, {
    threshold,
    includeAA: false,
    // diffMask: true writes ONLY genuinely different pixels (alpha 255) and
    // leaves everything else transparent — pixelmatch's default output also
    // paints non-diff pixels (gray blend, or gray on the identical fast path),
    // which would corrupt a binary mask derived from the alpha channel.
    diffMask: true,
  });

  // Binary mask of differing pixels (pixelmatch marks diffs with alpha > 0) plus
  // per-pixel color deltas for region statistics.
  const mask = new Uint8Array(total);
  const deltas = new Float32Array(total);
  const d = design.data;
  const s = screenshot.data;
  for (let i = 0; i < total; i++) {
    if (diffImage[i * 4 + 3]! > 0) mask[i] = 1;
    const o = i * 4;
    deltas[i] = colorDelta(d[o]!, d[o + 1]!, d[o + 2]!, s[o]!, s[o + 1]!, s[o + 2]!);
  }

  const components = findComponents(mask, width, height);
  const merged =
    components.length > MAX_MERGE_COMPONENTS
      ? components
      : mergeComponents(components, mergeMargin, width);
  const regions = merged
    .filter((pixels) => pixels.length >= minRegionPixels)
    .map((pixels) => summarizeRegion(pixels, deltas, width, height))
    .sort((a, b) => b.score - a.score || b.pixelCount - a.pixelCount)
    .map((region, i) => ({ ...region, id: i + 1, source: null }));

  const diffRatio = total === 0 ? 0 : diffPixelCount / total;
  return { diffPixelCount, totalPixelCount: total, diffRatio, diffImage, regions };
}

/** A rectangular area (pixel coordinates, inclusive-exclusive). */
export type Box2 = { x: number; y: number; width: number; height: number };

/**
 * Heuristic text detector: a region whose design crop has high luma variance
 * AND high contrast is text-like (glyph edges against a background), where
 * slight anti-aliasing differences are noise rather than real content diffs.
 */
export function isTextLikeRegion(image: RgbaImage, region: Box2): boolean {
  const x1 = Math.max(0, Math.floor(region.x));
  const y1 = Math.max(0, Math.floor(region.y));
  const x2 = Math.min(image.width, Math.ceil(region.x + region.width));
  const y2 = Math.min(image.height, Math.ceil(region.y + region.height));
  if (x2 <= x1 || y2 <= y1) return false;
  let sum = 0;
  let sumSq = 0;
  let min = 255;
  let max = 0;
  let n = 0;
  const data = image.data;
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      const o = (y * image.width + x) * 4;
      if (data[o + 3] === 0) continue; // transparent pixels don't anchor text
      const l = 0.299 * data[o]! + 0.587 * data[o + 1]! + 0.114 * data[o + 2]!;
      sum += l;
      sumSq += l * l;
      if (l < min) min = l;
      if (l > max) max = l;
      n++;
    }
  }
  if (n < 4) return false; // too few opaque pixels to judge
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  const std = Math.sqrt(Math.max(0, variance));
  return std >= 35 && max - min >= 100;
}

/**
 * Whether any pixel inside the region's crop still differs under a more
 * lenient pixelmatch threshold. Used to confirm that a region is real and not
 * merely anti-aliasing noise from text rendering.
 */
export function regionDiffersAt(
  design: RgbaImage,
  screenshot: RgbaImage,
  region: Box2,
  threshold: number,
): boolean {
  const x1 = Math.max(0, Math.floor(region.x));
  const y1 = Math.max(0, Math.floor(region.y));
  const x2 = Math.min(design.width, Math.ceil(region.x + region.width));
  const y2 = Math.min(design.height, Math.ceil(region.y + region.height));
  const w = x2 - x1;
  const h = y2 - y1;
  if (w <= 0 || h <= 0) return false;
  const cropDesign = Buffer.alloc(w * h * 4);
  const cropShot = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcStart = ((y1 + y) * design.width + x1) * 4;
    design.data.copy(cropDesign, y * w * 4, srcStart, srcStart + w * 4);
    screenshot.data.copy(cropShot, y * w * 4, srcStart, srcStart + w * 4);
  }
  const out = Buffer.alloc(w * h * 4);
  const count = pixelmatch(cropDesign, cropShot, out, w, h, {
    threshold,
    includeAA: false,
    diffMask: true,
  });
  return count > 0;
}

export interface DropTextNoiseOptions {
  /** More lenient pixelmatch threshold used to confirm text-like regions. */
  textThreshold: number;
  /** Extra text detector (e.g. the overlapping Figma node name matches a text pattern). */
  isText?: (region: Box2) => boolean;
}

/**
 * Drop text-like regions whose diff disappears under `textThreshold` — they
 * are anti-aliasing noise (a slightly different font/weight/rendering), not
 * real content differences. Non-text regions are never touched.
 */
export function dropTextNoise(
  design: RgbaImage,
  screenshot: RgbaImage,
  regions: DiffRegion[],
  options: DropTextNoiseOptions,
): { regions: DiffRegion[]; dropped: number } {
  const kept: DiffRegion[] = [];
  let dropped = 0;
  for (const region of regions) {
    const textLike = isTextLikeRegion(design, region) || (options.isText?.(region) ?? false);
    if (textLike && !regionDiffersAt(design, screenshot, region, options.textThreshold)) {
      dropped++;
    } else {
      kept.push(region);
    }
  }
  return { regions: kept, dropped };
}

interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Connected components (4-connectivity) over a binary mask. */
export function findComponents(mask: Uint8Array, width: number, _height: number): number[][] {
  const visited = new Uint8Array(mask.length);
  const components: number[][] = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || visited[start] === 1) continue;
    const stack = [start];
    visited[start] = 1;
    const pixels: number[] = [];
    while (stack.length > 0) {
      const p = stack.pop()!;
      pixels.push(p);
      const x = p % width;
      if (x > 0) {
        const n = p - 1;
        if (mask[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          stack.push(n);
        }
      }
      if (x < width - 1) {
        const n = p + 1;
        if (mask[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          stack.push(n);
        }
      }
      if (p >= width) {
        const n = p - width;
        if (mask[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          stack.push(n);
        }
      }
      if (p < mask.length - width) {
        const n = p + width;
        if (mask[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          stack.push(n);
        }
      }
    }
    components.push(pixels);
  }
  return components;
}

/** Union nearby components: two components merge when their boxes intersect
 * after being expanded by `margin` pixels on every side. */
export function mergeComponents(components: number[][], margin: number, width: number): number[][] {
  const n = components.length;
  if (n < 2) return components;

  // Bounding box of each component.
  const boxes: Box[] = components.map((pixels) => {
    let x1 = Infinity,
      y1 = Infinity,
      x2 = -1,
      y2 = -1;
    for (const p of pixels) {
      const x = p % width;
      const y = (p / width) | 0;
      if (x < x1) x1 = x;
      if (x > x2) x2 = x;
      if (y < y1) y1 = y;
      if (y > y2) y2 = y;
    }
    return { x1, y1, x2, y2 };
  });

  // Union-find over components; union pairs whose expanded boxes intersect.
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    let cur = i;
    while (parent[cur] !== cur) {
      parent[cur] = parent[parent[cur]!]!;
      cur = parent[cur]!;
    }
    return cur;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  // Merge when the gap between two boxes is <= margin on both axes (boxes use
  // inclusive coordinates, so subtract 1; overlapping axes count as gap <= 0
  // and always qualify).
  for (let i = 0; i < n; i++) {
    const a = boxes[i]!;
    for (let j = i + 1; j < n; j++) {
      const b = boxes[j]!;
      const gapX = Math.max(b.x1 - a.x2, a.x1 - b.x2) - 1;
      const gapY = Math.max(b.y1 - a.y2, a.y1 - b.y2) - 1;
      if (gapX <= margin && gapY <= margin) union(i, j);
    }
  }

  // Group pixel lists by root.
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push(...components[i]!);
    groups.set(root, list);
  }
  return [...groups.values()];
}

function summarizeRegion(
  pixels: number[],
  deltas: Float32Array,
  width: number,
  height: number,
): Omit<DiffRegion, 'id' | 'source'> {
  let x1 = Infinity,
    y1 = Infinity,
    x2 = -1,
    y2 = -1;
  let sumDelta = 0;
  let maxDelta = 0;
  for (const p of pixels) {
    const x = p % width;
    const y = (p / width) | 0;
    if (x < x1) x1 = x;
    if (x > x2) x2 = x;
    if (y < y1) y1 = y;
    if (y > y2) y2 = y;
    const delta = deltas[p]!;
    sumDelta += delta;
    if (delta > maxDelta) maxDelta = delta;
  }
  const regionWidth = x2 - x1 + 1;
  const regionHeight = y2 - y1 + 1;
  const bboxArea = regionWidth * regionHeight;
  const areaRatio = bboxArea / (width * height);
  const coverage = bboxArea === 0 ? 0 : pixels.length / bboxArea;
  const meanDelta = pixels.length === 0 ? 0 : sumDelta / pixels.length;
  const score = 0.6 * meanDelta + 0.25 * coverage + 0.15 * Math.min(1, areaRatio * 10);
  const severity = score >= 0.5 ? 'high' : score >= 0.2 ? 'medium' : 'low';
  return {
    x: x1,
    y: y1,
    width: regionWidth,
    height: regionHeight,
    pixelCount: pixels.length,
    coverage,
    areaRatio,
    meanDelta,
    maxDelta,
    score,
    severity,
  };
}
