export interface Viewport {
  width: number;
  height: number;
}

/** A decoded RGBA raster (length = width * height * 4). */
export interface RgbaImage {
  width: number;
  height: number;
  data: Buffer;
}

export interface CaptureOptions {
  /** Live URL to screenshot (http, https, or file). */
  url: string;
  /** Path to the static design image (PNG or JPG/JPEG). */
  designImagePath: string;
  /** Viewport in CSS pixels. Defaults to the design image's dimensions. */
  viewport?: Viewport;
  /** Directory for artifacts (screenshot + diff image). Defaults to a fresh temp dir. */
  outputDir?: string;
  /** CSS selector to wait for before screenshotting. */
  waitForSelector?: string;
  /** Extra settle time after page load, in ms. */
  waitMs?: number;
  /** pixelmatch threshold (0-1, smaller = more sensitive). Default 0.1. */
  diffThreshold?: number;
  /** Diff ratio at or below which the result is considered a match. Default 0.001. */
  matchThreshold?: number;
  /** Milliseconds to wait for the page to load. Default 30_000. */
  navigationTimeoutMs?: number;
}

export type Severity = 'high' | 'medium' | 'low';

/**
 * One grouped diff region — a cluster of differing pixels with its bounding box
 * and severity, instead of raw pixel noise.
 */
export interface DiffRegion {
  /** 1-based id, ordered by score descending. */
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Number of differing pixels inside the region. */
  pixelCount: number;
  /** Fraction of the region's bounding box that actually differs (0-1). */
  coverage: number;
  /** Fraction of the whole viewport the region's bounding box covers (0-1). */
  areaRatio: number;
  /** Mean per-pixel color delta inside the region (0-1). */
  meanDelta: number;
  /** Max per-pixel color delta inside the region (0-1). */
  maxDelta: number;
  /**
   * Composite severity score (0-1):
   * score = 0.6 * meanDelta + 0.25 * coverage + 0.15 * min(1, areaRatio * 10)
   */
  score: number;
  severity: Severity;
}

export interface CaptureInfo {
  url: string;
  viewport: Viewport;
  viewportSource: 'design' | 'provided';
  locale: string;
  timezoneId: string;
  reducedMotion: boolean;
  animationsDisabled: boolean;
  fontsWaited: boolean;
  durationMs: number;
}

export interface DiffArtifacts {
  /** Absolute path to the captured screenshot (PNG). */
  screenshotPath: string;
  /** Absolute path to the diff visualization (PNG; differing pixels highlighted). */
  diffImagePath: string;
  /** Absolute path to the design image used for the comparison. */
  designImagePath: string;
}

export interface DiffResult {
  /** 'match' when diffRatio <= matchThreshold (default 0.001), otherwise 'diff'. */
  status: 'match' | 'diff';
  /** 1 - diffRatio; 1 = pixel-identical. */
  similarity: number;
  diffPixelCount: number;
  totalPixelCount: number;
  diffRatio: number;
  regions: DiffRegion[];
  capture: CaptureInfo;
  artifacts: DiffArtifacts;
}
