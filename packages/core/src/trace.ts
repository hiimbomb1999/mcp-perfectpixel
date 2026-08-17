/**
 * Goal 2 — trace each diff region to its DOM element and real source location,
 * using only language-agnostic mechanisms:
 *
 *   1. CSS source maps — the standard build-tool-agnostic mechanism. Works
 *      regardless of what templating language generated the HTML, because it
 *      operates at the compiled-CSS layer. Each parsed rule carries its OWN
 *      source-map position (resolved from its byte offset) — duplicate
 *      selectors never share or misconsume positions.
 *   2. Gitignore-aware text search for the rule's selector (a ripgrep-style
 *      fallback; matches in gitignored paths are deprioritized as build output).
 *   3. If neither resolves, return the DOM/computed-style evidence as-is with
 *      low confidence — never guess a file.
 *
 * Design note: we never read `CSSStyleSheet.cssRules` in the browser — Chromium
 * blocks it for external stylesheets on file:// pages (and cross-origin
 * generally). Instead we fetch each stylesheet's text ourselves, parse it with
 * css-tree (which also gives us the byte offsets source maps need), and match
 * selectors against each region's element via `element.matches()` — only
 * candidate selectors (bucketed by the element's tag/class/id keys), so huge
 * Tailwind stylesheets don't turn into regions × selectors work.
 *
 * The caller (Claude Code, Cursor, ...) reads the repo and maps the returned
 * file/line hints to its own conventions.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as csstree from 'css-tree';
import type { Page } from 'playwright';
import type {
  Confidence,
  DiffRegion,
  RegionSource,
  RgbaImage,
  RuleEvidence,
  SourceLocation,
} from './types.js';
import {
  decodeSourceMap,
  extractSourceMappingUrl,
  offsetToLineCol,
  parseSourceMap,
  type SourceMapV3,
  type SourceMapResolver,
} from './sourcemap.js';
import { searchSelectors, type TextMatch } from './search.js';
import { buildPatches, findDesignTokens, type PatchRuleInput } from './patches.js';
import { assertTargetAllowed, type Mode } from './security.js';
import { elementKeys, selectorKeyOf, specificityOf, type Specificity } from './css.js';

/** Cap on candidate selectors matched per sample point (huge stylesheets). */
const MAX_CANDIDATES_PER_POINT = 300;
/** Cap on selectors searched in the repo per trace call. */
const MAX_SEARCH_SELECTORS = 100;

/** Visually relevant properties snapshotted on the region's element. */
const VISUAL_PROPS: readonly string[] = [
  'background',
  'background-color',
  'background-image',
  'color',
  'opacity',
  'border',
  'border-color',
  'border-width',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  'border-radius',
  'box-shadow',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'width',
  'height',
  'top',
  'left',
  'right',
  'bottom',
  'inset',
  'font',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'text-align',
  'text-decoration',
  'outline',
  'outline-color',
  'outline-width',
  'outline-style',
  'transform',
  'gap',
] as const;

type Applies = 'yes' | 'no' | 'unknown';

interface Point {
  x: number;
  y: number;
}

interface CollectedElement {
  tag: string;
  id: string | null;
  classes: string[];
  computed: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
}

interface SheetInfo {
  id: number;
  href: string | null;
  inlineText: string | null;
  skipped: boolean;
}

interface ParsedRule {
  selector: string;
  /** Bucket keys (tag, .class, #id of the last compound). */
  keyStrings: string[];
  specificity: Specificity;
  /** Byte offset of the rule's start in the generated stylesheet text. */
  offset: number;
  media: string | null;
  supports: string | null;
  container: string | null;
  /** Properties declared with !important. */
  important: Set<string>;
  properties: string[];
  declared: Record<string, string>;
  /**
   * Original source location resolved from THIS rule's own offset at load
   * time — duplicate selectors never share positions (no global counter).
   */
  sourceMapSource: SourceLocation | null;
  sheetId: number;
  /** Position in the sheet, for cascade order tie-breaking. */
  index: number;
}

interface LoadedSheet {
  text: string;
  baseUrl: string | null;
  resolver: SourceMapResolver | null;
  rules: ParsedRule[];
}

export interface TraceOptions {
  repoRoot: string;
  /** The (viewport-sized) design raster, for pixel-derived patch suggestions. */
  design: RgbaImage;
  /** Trust boundary for stylesheet/source-map fetching. */
  mode: Mode;
}

export interface TraceWarnings {
  warnings: string[];
}

/** Runs inside the page: element info + computed style at each sample point. */
const collectElementsScript = (arg: { points: Point[]; visualProps: readonly string[] }) => {
  const { points, visualProps } = arg;
  const sheets = Array.from(document.styleSheets);
  const sheetInfo = sheets.map((s, i) => ({
    id: i,
    href: s.href,
    inlineText:
      s.ownerNode && (s.ownerNode as Element).tagName === 'STYLE' ? s.ownerNode.textContent : null,
    skipped: !!(s.ownerNode && (s.ownerNode as Element).id === 'mcp-perfectpixel-determinism'),
  }));
  const elements = points.map(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    if (!el || el.nodeType !== 1 || el === document.documentElement || el === document.body) {
      return null;
    }
    const element = el as Element;
    const cs = getComputedStyle(element);
    const computed: Record<string, string> = {};
    for (const p of visualProps) computed[p] = cs.getPropertyValue(p);
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id || null,
      classes: Array.from(element.classList),
      computed,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  });
  return { elements, sheets: sheetInfo };
};

/** Runs inside the page: match candidate selectors + evaluate conditions. */
const matchScript = (arg: {
  points: Array<{ x: number; y: number; selectors: string[] }>;
  media: string[];
  supports: string[];
}) => {
  const { points, media, supports } = arg;
  const mediaResult: Record<string, Applies> = {};
  for (const c of media) {
    try {
      mediaResult[c] = window.matchMedia(c).matches ? 'yes' : 'no';
    } catch {
      mediaResult[c] = 'unknown';
    }
  }
  const supportsResult: Record<string, Applies> = {};
  for (const c of supports) {
    try {
      supportsResult[c] = (CSS as { supports?: (cond: string) => boolean }).supports
        ? CSS.supports(c)
          ? 'yes'
          : 'no'
        : 'unknown';
    } catch {
      supportsResult[c] = 'unknown';
    }
  }
  const perPoint = points.map(({ x, y, selectors }) => {
    const el = document.elementFromPoint(x, y);
    if (!el || el.nodeType !== 1) return null;
    const selMatches: Record<string, boolean> = {};
    for (const sel of selectors) {
      try {
        selMatches[sel] = (el as Element).matches(sel);
      } catch {
        selMatches[sel] = false;
      }
    }
    return selMatches;
  });
  return { perPoint, mediaResult, supportsResult };
};

/**
 * Attach `source` (element evidence + per-rule source locations + confidence)
 * to each region, plus minimal patch suggestions. Best-effort — failures are
 * reported through `warnings` instead of being swallowed.
 */
export async function traceRegions(
  page: Page,
  regions: DiffRegion[],
  options: TraceOptions,
): Promise<{ regions: DiffRegion[]; warnings: string[] }> {
  const warnings: string[] = [];
  if (regions.length === 0) return { regions, warnings };
  const { repoRoot, mode } = options;

  // Sample several points per region (center + quarter points) so the element
  // is found even when the center sits on a transparent/empty spot.
  const pointsPerRegion = regions.map(regionSamplePoints);
  const points = pointsPerRegion.flat();

  const phase1 = await page.evaluate(collectElementsScript, { points, visualProps: VISUAL_PROPS });
  const perPointElements = phase1.elements as Array<CollectedElement | null>;
  const sheetsInfo = phase1.sheets as SheetInfo[];

  // Load each stylesheet's text, source map, and parsed rules. Each rule's
  // source-map position is resolved HERE from its own offset.
  const loaded = new Map<number, LoadedSheet>();
  for (const info of sheetsInfo) {
    if (info.skipped) continue;
    const sheet = await loadSheet(info, mode, page);
    if (!sheet) continue;
    const mapUrl = extractSourceMappingUrl(sheet.text);
    const map = mapUrl ? await loadMap(mapUrl, sheet.baseUrl, mode) : null;
    const resolver = map ? decodeSourceMap(map) : null;
    const rules = parseRules(sheet.text, info.id);
    for (const rule of rules) {
      rule.sourceMapSource = resolver
        ? resolveRuleSource(rule, resolver, sheet.text, sheet.baseUrl, repoRoot)
        : null;
    }
    loaded.set(info.id, { ...sheet, resolver, rules });
  }

  // Bucket selectors by element keys (tag / .class / #id of last compound).
  const bucket = new Map<string, string[]>();
  const selectorList: string[] = [];
  for (const sheet of loaded.values()) {
    for (const rule of sheet.rules) {
      if (!selectorList.includes(rule.selector)) selectorList.push(rule.selector);
      for (const key of rule.keyStrings) {
        const list = bucket.get(key) ?? [];
        if (!list.includes(rule.selector)) list.push(rule.selector);
        bucket.set(key, list);
      }
    }
  }

  // Candidate selectors per point — only selectors whose last compound could
  // match the element (avoid regions × all-selectors for huge stylesheets).
  const candidatePoints = points.map((p, i) => {
    const el = perPointElements[i];
    if (!el) return { ...p, selectors: [] };
    const keys = elementKeys(el.tag, el.classes, el.id);
    const seen = new Set<string>();
    const selectors: string[] = [];
    for (const key of keys) {
      for (const sel of bucket.get(key) ?? []) {
        if (!seen.has(sel)) {
          seen.add(sel);
          selectors.push(sel);
          if (selectors.length >= MAX_CANDIDATES_PER_POINT) break;
        }
      }
      if (selectors.length >= MAX_CANDIDATES_PER_POINT) break;
    }
    return { ...p, selectors };
  });

  // Phase 3: match candidates + evaluate @media / @supports conditions.
  // Collect chains from ALL rules (not just the first per selector), so
  // conditional rules are actually evaluated.
  const allParsedRules = [...loaded.values()].flatMap((s) => s.rules);
  const media = [...new Set(allParsedRules.map((r) => r.media).filter((c): c is string => !!c))];
  const supports = [
    ...new Set(allParsedRules.map((r) => r.supports).filter((c): c is string => !!c)),
  ];
  const phase3 = await page.evaluate(matchScript, { points: candidatePoints, media, supports });
  const mediaResult = phase3.mediaResult as Record<string, Applies>;
  const supportsResult = phase3.supportsResult as Record<string, Applies>;
  const perPointMatches = phase3.perPoint as Array<Record<string, boolean> | null>;

  // Text-search fallback: selectors that actually matched, one repo walk.
  const matchedSelectors = new Set<string>();
  for (const selMatches of perPointMatches) {
    if (!selMatches) continue;
    for (const sel of selectorList) {
      if (selMatches[sel]) matchedSelectors.add(sel);
    }
  }
  const searchSelectorsToRun = [...matchedSelectors].slice(0, MAX_SEARCH_SELECTORS);
  if ([...matchedSelectors].length > MAX_SEARCH_SELECTORS) {
    warnings.push(
      `search truncated: ${matchedSelectors.size} matched selectors, searching the first ${MAX_SEARCH_SELECTORS}`,
    );
  }
  const searchMatches =
    searchSelectorsToRun.length > 0
      ? await searchSelectors(repoRoot, searchSelectorsToRun, sheetNearPath(loaded, repoRoot))
      : new Map<string, TextMatch[]>();

  // Design tokens for patch suggestions (one repo walk).
  const tokens = await findDesignTokens(repoRoot);

  const out: DiffRegion[] = [];
  let pointCursor = 0;
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i]!;
    const regionPoints = pointsPerRegion[i]!;
    const pointIndices = regionPoints.map((_, j) => pointCursor + j);
    pointCursor += regionPoints.length;

    const picked = pickElement(
      region,
      pointIndices.map((idx) => perPointElements[idx] ?? null),
    );
    if (!picked) {
      out.push({ ...region, source: null });
      warnings.push(`region ${region.id}: no element found at any sample point`);
      continue;
    }
    // Use the matches of the point that produced the picked element.
    const bestPointIdx = pointIndices[picked.pointIndex]!;
    const selMatches = perPointMatches[bestPointIdx] ?? {};

    const source = buildRegionSource(
      picked.element,
      loaded,
      selMatches,
      mediaResult,
      supportsResult,
      searchMatches,
    );
    const matchedRules = collectMatchedRules(
      picked.element,
      loaded,
      selMatches,
      mediaResult,
      supportsResult,
    );
    const patchInputs: PatchRuleInput[] = matchedRules.map(({ sheetId, index, rule }) => {
      const fb = searchFallback(rule.selector, searchMatches);
      return {
        selector: rule.selector,
        specificity: rule.specificity,
        sheetId,
        index,
        important: rule.important,
        properties: rule.properties,
        declared: rule.declared,
        source: rule.sourceMapSource ?? fb.source,
        confidence: rule.sourceMapSource ? 'high' : fb.confidence,
      };
    });
    source.patches = buildPatches(
      options.design,
      region,
      patchInputs,
      picked.element.computed,
      tokens,
    );
    out.push({ ...region, source });
  }
  return { regions: out, warnings };
}

/** Sample points for a region: center + quarter points, clamped to the bbox. */
export function regionSamplePoints(r: Pick<DiffRegion, 'x' | 'y' | 'width' | 'height'>): Point[] {
  const raw = [
    { x: r.x + r.width / 2, y: r.y + r.height / 2 },
    { x: r.x + r.width * 0.2, y: r.y + r.height * 0.2 },
    { x: r.x + r.width * 0.8, y: r.y + r.height * 0.8 },
    { x: r.x + r.width * 0.2, y: r.y + r.height * 0.8 },
    { x: r.x + r.width * 0.8, y: r.y + r.height * 0.2 },
  ];
  const seen = new Set<string>();
  const pts: Point[] = [];
  for (const p of raw) {
    const x = Math.round(Math.max(r.x, Math.min(r.x + r.width - 1, p.x)));
    const y = Math.round(Math.max(r.y, Math.min(r.y + r.height - 1, p.y)));
    const k = `${x},${y}`;
    if (seen.has(k)) continue;
    seen.add(k);
    pts.push({ x, y });
  }
  return pts;
}

/** Choose the element whose rect overlaps the region the most. */
export function pickElement(
  region: Pick<DiffRegion, 'x' | 'y' | 'width' | 'height'>,
  candidates: Array<CollectedElement | null>,
): { element: CollectedElement; pointIndex: number } | null {
  let best: CollectedElement | null = null;
  let bestPoint = -1;
  let bestOverlap = -1;
  let bestArea = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c) continue;
    const overlap = intersectionArea(region, c.rect);
    const area = c.rect.width * c.rect.height;
    if (overlap > bestOverlap || (overlap === bestOverlap && area < bestArea)) {
      best = c;
      bestPoint = i;
      bestOverlap = overlap;
      bestArea = area;
    }
  }
  if (!best || bestPoint < 0) return null;
  return { element: best, pointIndex: bestPoint };
}

function intersectionArea(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function appliesFor(
  rule: ParsedRule,
  mediaResult: Record<string, Applies>,
  supportsResult: Record<string, Applies>,
): Applies {
  // Container queries can't be evaluated from the CSSOM side — report unknown.
  if (rule.container !== null) return 'unknown';
  if (rule.media !== null && mediaResult[rule.media] === 'no') return 'no';
  if (rule.supports !== null && supportsResult[rule.supports] === 'no') return 'no';
  if (rule.media !== null && mediaResult[rule.media] === 'unknown') return 'unknown';
  if (rule.supports !== null && supportsResult[rule.supports] === 'unknown') return 'unknown';
  return 'yes';
}

/** Rules matching the element with conditions that currently apply. */
function collectMatchedRules(
  el: CollectedElement,
  loaded: Map<number, LoadedSheet>,
  selMatches: Record<string, boolean>,
  mediaResult: Record<string, Applies>,
  supportsResult: Record<string, Applies>,
): Array<{ sheetId: number; index: number; rule: ParsedRule }> {
  const matched: Array<{ sheetId: number; index: number; rule: ParsedRule }> = [];
  for (const [sheetId, sheet] of loaded) {
    for (let index = 0; index < sheet.rules.length; index++) {
      const rule = sheet.rules[index]!;
      if (selMatches[rule.selector] !== true) continue;
      if (appliesFor(rule, mediaResult, supportsResult) === 'no') continue;
      matched.push({ sheetId, index, rule });
    }
  }
  void el;
  return matched;
}

function buildRegionSource(
  el: CollectedElement,
  loaded: Map<number, LoadedSheet>,
  selMatches: Record<string, boolean>,
  mediaResult: Record<string, Applies>,
  supportsResult: Record<string, Applies>,
  searchMatches: Map<string, TextMatch[]>,
): RegionSource {
  const elementSelector = el.id
    ? `#${el.id}`
    : el.classes.length > 0
      ? `${el.tag}${el.classes.map((c) => `.${c}`).join('')}`
      : el.tag;

  const matched = collectMatchedRules(el, loaded, selMatches, mediaResult, supportsResult);

  const rules: RuleEvidence[] = matched.map(({ rule }) => {
    let source: SourceLocation | null = rule.sourceMapSource;
    let confidence: Confidence = source ? 'high' : 'low';

    // Text-search fallback.
    if (!source) {
      const fb = searchFallback(rule.selector, searchMatches);
      source = fb.source;
      confidence = fb.confidence;
    }

    return {
      selector: rule.selector,
      media: rule.media,
      supports: rule.supports,
      container: rule.container,
      applies: appliesFor(rule, mediaResult, supportsResult),
      properties: rule.properties,
      declared: rule.declared,
      source,
      confidence,
    };
  });

  const confidence: Confidence = rules.some((r) => r.confidence === 'high')
    ? 'high'
    : rules.some((r) => r.confidence === 'medium')
      ? 'medium'
      : 'low';

  return {
    element: {
      tag: el.tag,
      id: el.id,
      classes: el.classes,
      selector: elementSelector,
      computedStyle: el.computed,
    },
    rules,
    confidence,
    patches: [],
  };
}

/** Best text-search match for a selector → source + confidence. */
function searchFallback(
  selector: string,
  searchMatches: Map<string, TextMatch[]>,
): { source: SourceLocation | null; confidence: Confidence } {
  const best = searchMatches.get(selector)?.[0];
  if (!best) return { source: null, confidence: 'low' };
  // Non-source contexts (tests, docs, generated) are deprioritized: the real
  // source lives elsewhere, so the match is low-confidence evidence only.
  const credible = best.context === 'source' || best.context === 'source-css';
  return {
    source: {
      file: best.file,
      line: best.line,
      column: best.column,
      via: 'text-search',
      gitignored: best.gitignored,
      context: best.context,
    },
    confidence: best.gitignored || !credible ? 'low' : 'medium',
  };
}

/** Repo-relative path of the first local stylesheet, for search ranking. */
function sheetNearPath(loaded: Map<number, LoadedSheet>, repoRoot: string): string | undefined {
  for (const sheet of loaded.values()) {
    if (sheet.baseUrl?.startsWith('file:')) {
      try {
        const abs = fileURLToPath(sheet.baseUrl);
        const rel = path.relative(repoRoot, abs);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
          return rel.split(path.sep).join('/');
        }
      } catch {
        // Keep looking.
      }
    }
  }
  return undefined;
}

/** Resolve a rule's source position from ITS OWN offset (no shared counter). */
function resolveRuleSource(
  rule: ParsedRule,
  resolver: SourceMapResolver,
  cssText: string,
  baseUrl: string | null,
  repoRoot: string,
): SourceLocation | null {
  const { line, column } = offsetToLineCol(cssText, rule.offset);
  const pos = resolver.resolve(line, column);
  if (!pos) return null;
  const rawFile = resolver.sourcePath(pos.sourceIndex);
  if (!rawFile) return null;
  return {
    file: normalizeSourceFile(rawFile, baseUrl, repoRoot),
    line: pos.line + 1,
    column: pos.column + 1,
    via: 'source-map',
    gitignored: false,
  };
}

/** Resolve a map-relative source path to repo-relative when possible. */
function normalizeSourceFile(raw: string, baseUrl: string | null, repoRoot: string): string {
  if (baseUrl?.startsWith('file:')) {
    try {
      const abs = fileURLToPath(new URL(raw, baseUrl));
      const rel = path.relative(repoRoot, abs);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        return rel.split(path.sep).join('/');
      }
    } catch {
      // Keep the raw path.
    }
  }
  return raw;
}

async function loadSheet(
  info: SheetInfo,
  mode: Mode,
  page: Page,
): Promise<{ text: string; baseUrl: string | null } | null> {
  if (info.inlineText !== null) {
    return { text: info.inlineText, baseUrl: null };
  }
  if (info.href) {
    try {
      if (info.href.startsWith('file:')) {
        if (mode === 'hosted') return null; // file:// blocked in hosted mode
        const text = await readFile(fileURLToPath(info.href), 'utf8');
        return { text, baseUrl: info.href };
      }
      assertTargetAllowed(info.href, mode, 'stylesheet');
      // Fetch through the browser's request context so cookies/session of the
      // page apply and the content matches what the browser actually loaded.
      const res = await page.request.get(info.href, { timeout: 15_000 });
      if (!res.ok()) return null;
      return { text: await res.text(), baseUrl: info.href };
    } catch {
      return null;
    }
  }
  return null;
}

async function loadMap(
  mapUrl: string,
  baseUrl: string | null,
  mode: Mode,
): Promise<SourceMapV3 | null> {
  try {
    if (mapUrl.startsWith('data:')) {
      const comma = mapUrl.indexOf(',');
      const meta = mapUrl.slice(5, comma);
      const payload = mapUrl.slice(comma + 1);
      const data = /;base64$/i.test(meta)
        ? Buffer.from(payload, 'base64').toString('utf8')
        : decodeURIComponent(payload);
      return parseSourceMap(data);
    }
    const abs = baseUrl ? new URL(mapUrl, baseUrl) : new URL(mapUrl, 'file:///');
    if (abs.protocol === 'file:') {
      if (mode === 'hosted') return null; // file:// blocked in hosted mode
      const data = await readFile(fileURLToPath(abs), 'utf8');
      return parseSourceMap(data);
    }
    assertTargetAllowed(abs.toString(), mode, 'source map');
    const res = await fetch(abs, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return parseSourceMap(await res.text());
  } catch {
    return null;
  }
}

/** True for selectors like `*`, `*::before`, `*, *::before, *::after`. */
function isUniversalSelector(selector: string): boolean {
  return selector.split(',').every((part) => /^\s*\*(\s*::(before|after))?\s*$/.test(part));
}

/**
 * Parse a stylesheet's text: every rule with its byte offset, cascade
 * metadata, conditional at-rule chains, and visually relevant declarations.
 */
function parseRules(cssText: string, sheetId: number): ParsedRule[] {
  let ast;
  try {
    ast = csstree.parse(cssText, { positions: true });
  } catch {
    return [];
  }
  const out: ParsedRule[] = [];
  const mediaStack: string[] = [];
  const supportsStack: string[] = [];
  const containerStack: string[] = [];
  const chain = (stack: string[]): string | null => {
    const parts = stack.filter((c) => c !== '');
    return parts.length > 0 ? parts.join(' and ') : null;
  };
  csstree.walk(ast, {
    enter(node: csstree.CssNode) {
      if (node.type === 'Atrule') {
        const prelude = (node.prelude ? csstree.generate(node.prelude) : '').trim();
        if (node.name === 'media') mediaStack.push(prelude);
        else if (node.name === 'supports') supportsStack.push(prelude);
        else if (node.name === 'container') containerStack.push(prelude);
      } else if (node.type === 'Rule') {
        const start = node.loc?.start.offset;
        if (start === undefined) return;
        let selector = '';
        try {
          selector = csstree.generate(node.prelude);
        } catch {
          return;
        }
        if (isUniversalSelector(selector)) return;
        const properties: string[] = [];
        const declared: Record<string, string> = {};
        const important = new Set<string>();
        if (node.block) {
          node.block.children.forEach((decl: csstree.CssNode) => {
            if (decl.type !== 'Declaration') return;
            if (!VISUAL_PROPS.includes(decl.property)) return;
            let value = '';
            try {
              value = csstree.generate(decl.value);
            } catch {
              return;
            }
            properties.push(decl.property);
            declared[decl.property] = value;
            if (decl.important) important.add(decl.property);
          });
        }
        const key = selectorKeyOf(selector);
        const keyStrings = [
          ...key.tags,
          ...key.classes.map((c) => `.${c}`),
          ...key.ids.map((i) => `#${i}`),
        ];
        out.push({
          selector,
          keyStrings,
          specificity: specificityOf(selector),
          offset: start,
          media: chain(mediaStack),
          supports: chain(supportsStack),
          container: chain(containerStack),
          important,
          properties,
          declared,
          sourceMapSource: null,
          sheetId,
          index: out.length,
        });
      }
    },
    leave(node: csstree.CssNode) {
      if (node.type === 'Atrule') {
        if (node.name === 'media') mediaStack.pop();
        else if (node.name === 'supports') supportsStack.pop();
        else if (node.name === 'container') containerStack.pop();
      }
    },
  });
  return out;
}
