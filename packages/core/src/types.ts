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
   * gitignore-aware). Defaults to `process.cwd()` — required in hosted mode.
   */
  repoRoot?: string;
  /**
   * Trust boundary: 'local' (default) allows file:// URLs and local paths;
   * 'hosted' blocks file://, private-network hosts, and local paths (SSRF
   * protection) and requires an explicit repoRoot.
   */
  mode?: 'local' | 'hosted';
  /**
   * How much computed style to include per region: 'minimal' (default) keeps
   * the color-candidate properties plus any value that differs from the
   * element's parent (token-friendly); 'full' returns all 50+ properties;
   * 'none' omits computed style entirely.
   */
  computedStyle?: 'full' | 'minimal' | 'none';
  /**
   * Resolve each diff region to a DOM element and a best-effort source
   * location (CSS source maps first, then gitignore-aware text search).
   * Default true.
   */
  trace?: boolean;
  /**
   * Codebase type — narrows source search priority globs and token scanning
   * (e.g. SCSS variables, Shopify theme schema JSON). Default 'auto' (detected
   * from repoRoot markers).
   */
  platform?: Platform;
  /** Extra design context (from Figma MCP): export scale, resolved tokens, node boxes. */
  designContext?: DesignContext;
  /**
   * Extra pixelmatch threshold for text-like regions (high color variance).
   * When set, regions whose diff disappears under this more lenient threshold
   * are dropped as anti-aliasing noise.
   */
  textRegionThreshold?: number;
}

export type Severity = 'high' | 'medium' | 'low';

/** Codebase type — narrows source search priority and token scanning. */
export type Platform = 'shopify' | 'bigcommerce' | 'html-tailwind' | 'react' | 'vue' | 'auto';

/** A design token resolved from Figma (variables/styles) — ground truth. */
export interface FigmaToken {
  name: string;
  value: string;
  kind: 'color' | 'spacing' | 'radius' | 'font';
}

/** A Figma node bounding box (design image coordinate space). */
export interface FigmaNode {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Extra design context provided by the caller (e.g. from Figma MCP). */
export interface DesignContext {
  /** Export scale of the design image relative to the Figma frame (1/2/3). */
  scale?: number;
  /** Figma-resolved tokens — matched before repo-scanned tokens. */
  tokens?: FigmaToken[];
  /** Figma node boxes for annotating regions with layer names. */
  nodes?: FigmaNode[];
}

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
  /** Figma layer name of the node overlapping this region (when designContext.nodes given). */
  figmaNode?: string | null;
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
  /** For text-search matches: where the match lives (source/test/docs/...). */
  context?:
    'source-css' | 'source' | 'test' | 'docs' | 'generated' | 'liquid-schema' | 'vue-sfc-style';
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
  /** @media condition chain, e.g. "(max-width: 600px)". Null when unconditional. */
  media: string | null;
  /** @supports condition chain. Null when unconditional. */
  supports: string | null;
  /** @container condition chain. Null when unconditional. */
  container: string | null;
  /**
   * Whether the rule's conditions currently apply: 'yes' / 'no', or 'unknown'
   * when they can't be evaluated from the outside (e.g. container queries).
   */
  applies: 'yes' | 'no' | 'unknown';
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
  /**
   * Human-readable hints for cases with no anchorable patch — e.g. the
   * culprit color is inherited from an ancestor, or set by an inline style /
   * unmatched rule. Never guesses a file.
   */
  notes: string[];
}

/** Design token kind, incl. SCSS variables ($var) from platforms like BigCommerce. */
export type TokenKind = 'css-variable' | 'scss' | 'tailwind' | 'style-dictionary';

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
   * color matches a token (Figma-resolved first, then repo-scanned), otherwise
   * the hex value derived from the design image.
   */
  suggested: string;
  /** The normalized hex color the design image shows at the region. */
  value: string;
  /** The matched repo-scanned token, when one was preferred over a hardcoded value. */
  token: DesignToken | null;
  /** The matched Figma-resolved token (ground truth), when provided and matching. */
  figmaToken?: { name: string; value: string; kind: string } | null;
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
  /**
   * How many distinct @media / @container queries the page's stylesheets use
   * (only when tracing ran). Non-zero means the page is responsive — treat
   * any pixel width/height in the output as viewport-specific, never as a
   * fixed value to hardcode.
   */
  responsive?: { mediaQueries: number; containerQueries: number };
}

export interface DiffArtifacts {
  /** Absolute path to the captured screenshot (PNG). */
  screenshotPath: string;
  /** Absolute path to the diff visualization (PNG; differing pixels highlighted). */
  diffImagePath: string;
  /** The design image used: absolute local path, or the remote URL as given. */
  designImagePath: string;
  /** The exact designImagePath value passed to the capture. */
  designImageSource: string;
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
  /**
   * Source-tracing outcome: 'skipped' (no regions / tracing disabled), 'ok',
   * 'partial' (some warnings), or 'failed' (tracing errored — regions fall
   * back to untraced evidence). Warnings are never silently swallowed.
   */
  trace: {
    status: 'skipped' | 'ok' | 'partial' | 'failed';
    warnings: string[];
  };
  /** Codebase root used for source tracing (resolved absolute path). */
  repoRoot: string;
}
