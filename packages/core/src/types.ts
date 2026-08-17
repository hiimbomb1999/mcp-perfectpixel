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
  /**
   * Root of the codebase to search for source locations (text-search fallback,
   * gitignore-aware). Defaults to `process.cwd()`.
   */
  repoRoot?: string;
  /**
   * Resolve each diff region to a DOM element and a best-effort source
   * location (CSS source maps first, then gitignore-aware text search).
   * Default true.
   */
  trace?: boolean;
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
  /**
   * Best-effort source resolution for this region: the DOM element at the
   * region and the CSS rules (with source locations) that style it.
   * `null` when tracing is disabled or the region has no element.
   */
  source: RegionSource | null;
}

/** How confident we are that a source location is the real origin. */
export type Confidence = 'high' | 'medium' | 'low';

export interface SourceLocation {
  /** Path relative to repoRoot. */
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  /** How the location was resolved. */
  via: 'source-map' | 'text-search';
  /** True when the file is gitignored (e.g. compiled/build output). */
  gitignored: boolean;
}

/** The DOM element sitting at a diff region. */
export interface ElementEvidence {
  tag: string;
  id: string | null;
  classes: string[];
  /** Best-effort selector derived from id/classes/tag. */
  selector: string;
  /** Computed values of visually relevant properties. */
  computedStyle: Record<string, string>;
}

/** One CSS rule that matched the region's element. */
export interface RuleEvidence {
  selector: string;
  /** Media/container condition chain, e.g. "(max-width: 600px)". Null when unconditional. */
  media: string | null;
  /** Whether the rule's media conditions currently apply. */
  applies: boolean;
  /** Visually relevant properties this rule declares. */
  properties: string[];
  /** The rule's declared values for those properties. */
  declared: Record<string, string>;
  /**
   * Original source location: from a CSS source map (high confidence), or a
   * gitignore-aware text search for the selector (medium/low). Null when
   * nothing was found — the DOM/computed-style evidence is then the only signal.
   */
  source: SourceLocation | null;
  confidence: Confidence;
}

/** Per-region tracing result. */
export interface RegionSource {
  element: ElementEvidence;
  rules: RuleEvidence[];
  /** Highest confidence among rules; 'low' when nothing resolved. */
  confidence: Confidence;
  /**
   * Minimal patch suggestions for this region: smallest changes
   * (file, line, property, current → suggested), preferring tokens the
   * project already defines. Empty when nothing actionable resolved.
   */
  patches: PatchSuggestion[];
}

export type TokenKind = 'css-variable' | 'tailwind' | 'style-dictionary';

/** A design token the project already defines. */
export interface DesignToken {
  /** Token name, e.g. `--color-success` or `colors.success`. */
  name: string;
  /** How to reference it in a patch, e.g. `var(--color-success)`. */
  reference: string;
  /** Normalized hex value, e.g. `#16a34a`. */
  value: string;
  /** Repo-relative path of the file defining it. */
  file: string;
  /** 1-based line of the definition. */
  line: number;
  kind: TokenKind;
}

/** A minimal, anchorable single-property change. */
export interface PatchSuggestion {
  /** Repo-relative file to change (the rule's source location). */
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  /** The property to change, e.g. `background-color`. */
  property: string;
  /** The value currently declared by the rule, e.g. `#dc2626`. */
  current: string;
  /**
   * The minimal suggested replacement: a token reference when the design
   * color matches a project token, otherwise the hex value derived from the
   * design image.
   */
  suggested: string;
  /** The normalized hex color the design image shows at the region. */
  value: string;
  /** The matched token, when one was preferred over a hardcoded value. */
  token: DesignToken | null;
  /** Inherited from the rule's source confidence. */
  confidence: Confidence;
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
  /** Codebase root used for source tracing (resolved absolute path). */
  repoRoot: string;
}
