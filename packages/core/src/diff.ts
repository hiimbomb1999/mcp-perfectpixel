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

/** Bounding boxes whose gap is <= margin are merged into one region. */
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
  const expanded = (box: Box) => ({
    x1: box.x1 - margin,
    y1: box.y1 - margin,
    x2: box.x2 + margin,
    y2: box.y2 + margin,
  });
  for (let i = 0; i < n; i++) {
    const a = expanded(boxes[i]!);
    for (let j = i + 1; j < n; j++) {
      const b = expanded(boxes[j]!);
      if (a.x1 <= b.x2 && b.x1 <= a.x2 && a.y1 <= b.y2 && b.y1 <= a.y2) union(i, j);
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
