/**
 * Goal 2 — trace each diff region to its DOM element and real source location,
 * using only language-agnostic mechanisms:
 *
 *   1. CSS source maps — the standard build-tool-agnostic mechanism. Works
 *      regardless of what templating language generated the HTML, because it
 *      operates at the compiled-CSS layer.
 *   2. Gitignore-aware text search for the rule's selector (a ripgrep-style
 *      fallback; matches in gitignored paths are deprioritized as build output).
 *   3. If neither resolves, return the DOM/computed-style evidence as-is with
 *      low confidence — never guess a file.
 *
 * Design note: we never read `CSSStyleSheet.cssRules` in the browser — Chromium
 * blocks it for external stylesheets on file:// pages (and cross-origin
 * generally). Instead we fetch each stylesheet's text ourselves, parse it with
 * css-tree (which also gives us the byte offsets source maps need), and match
 * selectors against the region's element via `element.matches()`.
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
  RuleEvidence,
  SourceLocation,
} from './types.js';
import {
  decodeMappings,
  extractSourceMappingUrl,
  mapOffset,
  parseSourceMap,
  type Segment,
  type SourceMapV3,
} from './sourcemap.js';
import { searchSelectors, type TextMatch } from './search.js';
import { buildPatches, findDesignTokens } from './patches.js';
import type { RgbaImage } from './types.js';

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

interface Point {
  x: number;
  y: number;
}

interface CollectedElement {
  tag: string;
  id: string | null;
  classes: string[];
  computed: Record<string, string>;
}

interface SheetInfo {
  id: number;
  href: string | null;
  inlineText: string | null;
  skipped: boolean;
}

interface ParsedRule {
  selector: string;
  /** Byte offset of the rule's start in the generated stylesheet text. */
  offset: number;
  /** Media/container/supports condition chain, e.g. "(max-width: 600px)". */
  mediaChain: string | null;
  properties: string[];
  declared: Record<string, string>;
}

interface LoadedSheet {
  text: string;
  baseUrl: string | null;
  map: SourceMapV3 | null;
  segments: Map<number, Segment[]> | null;
  rules: ParsedRule[];
}

export interface TraceOptions {
  repoRoot: string;
  /** The (viewport-sized) design raster, for pixel-derived patch suggestions. */
  design: RgbaImage;
}

/**
 * Runs inside the page (phase 1): finds the element at each region center and
 * snapshots its computed style. Rule matching happens in phase 3 via
 * `element.matches()` — CSSOM rule access is blocked for external stylesheets.
 */
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
    const cs = getComputedStyle(el as Element);
    const computed: Record<string, string> = {};
    for (const p of visualProps) computed[p] = cs.getPropertyValue(p);
    return {
      tag: (el as Element).tagName.toLowerCase(),
      id: (el as Element).id || null,
      classes: Array.from((el as Element).classList),
      computed,
    };
  });
  return { elements, sheets: sheetInfo };
};

/**
 * Runs inside the page (phase 3): for each region center, which selectors
 * match the element, and whether each media chain currently applies.
 */
const matchScript = (arg: { points: Point[]; selectors: string[]; mediaChains: string[] }) => {
  const { points, selectors, mediaChains } = arg;
  const chainMatches: Record<string, boolean> = {};
  for (const chain of mediaChains) {
    try {
      chainMatches[chain] = window.matchMedia(chain).matches;
    } catch {
      chainMatches[chain] = true;
    }
  }
  const perPoint = points.map(({ x, y }) => {
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
  return { perPoint, chainMatches };
};

/**
 * Attach `source` (element evidence + per-rule source locations + confidence)
 * to each region. Best-effort — failures degrade to DOM evidence only.
 */
export async function traceRegions(
  page: Page,
  regions: DiffRegion[],
  options: TraceOptions,
): Promise<DiffRegion[]> {
  if (regions.length === 0) return regions;
  const { repoRoot } = options;
  const points = regions.map((r) => ({
    x: Math.round(r.x + r.width / 2),
    y: Math.round(r.y + r.height / 2),
  }));

  const phase1 = await page.evaluate(collectElementsScript, { points, visualProps: VISUAL_PROPS });
  const elements = phase1.elements as Array<CollectedElement | null>;
  const sheetsInfo = phase1.sheets as SheetInfo[];

  // Load each stylesheet's text, source map, and parsed rules.
  const loaded = new Map<number, LoadedSheet>();
  for (const info of sheetsInfo) {
    if (info.skipped) continue;
    const sheet = await loadSheet(info);
    if (!sheet) continue;
    const mapUrl = extractSourceMappingUrl(sheet.text);
    const map = mapUrl ? await loadMap(mapUrl, sheet.baseUrl) : null;
    const segments = map ? decodeMappings(map.mappings) : null;
    loaded.set(info.id, { ...sheet, map, segments, rules: parseRules(sheet.text) });
  }

  // Phase 3: match selectors + evaluate media chains in the page.
  const allRules = [...loaded.values()].flatMap((s) => s.rules);
  const selectors = [...new Set(allRules.map((r) => r.selector))];
  const mediaChains = [
    ...new Set(allRules.map((r) => r.mediaChain).filter((c): c is string => !!c)),
  ];
  const phase3 = await page.evaluate(matchScript, { points, selectors, mediaChains });

  // Text-search fallback: selectors of rules that actually matched, one repo walk.
  const matchedSelectors = new Set<string>();
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const selMatches = phase3.perPoint[i];
    if (!el || !selMatches) continue;
    for (const sel of selectors) {
      if (selMatches[sel]) matchedSelectors.add(sel);
    }
  }
  const searchMatches =
    matchedSelectors.size > 0
      ? await searchSelectors(repoRoot, [...matchedSelectors])
      : new Map<string, TextMatch[]>();

  // Per-(sheet, selector) counters so duplicate selectors map in order.
  const consumed = new Map<string, number>();
  const takeOffset = (sheetId: number, selector: string): number | null => {
    const sheet = loaded.get(sheetId);
    if (!sheet) return null;
    const offsets = sheet.rules.filter((r) => r.selector === selector).map((r) => r.offset);
    if (offsets.length === 0) return null;
    const key = `${sheetId}\u0000${selector}`;
    const idx = consumed.get(key) ?? 0;
    consumed.set(key, idx + 1);
    return offsets[Math.min(idx, offsets.length - 1)] ?? null;
  };

  // Design tokens for patch suggestions (one repo walk).
  const tokens = await findDesignTokens(repoRoot);

  return regions.map((region, i) => {
    const el = elements[i];
    const selMatches = phase3.perPoint[i];
    const chainMatches = phase3.chainMatches as Record<string, boolean>;
    if (!el || !selMatches) return { ...region, source: null };
    const source = buildRegionSource(
      el,
      loaded,
      selMatches,
      chainMatches,
      takeOffset,
      searchMatches,
      repoRoot,
    );
    // Goal 3: minimal patch suggestions, preferring project tokens.
    source.patches = buildPatches(options.design, region, source.rules, tokens);
    return { ...region, source };
  });
}

function buildRegionSource(
  el: CollectedElement,
  loaded: Map<number, LoadedSheet>,
  selMatches: Record<string, boolean>,
  chainMatches: Record<string, boolean>,
  takeOffset: (sheetId: number, selector: string) => number | null,
  searchMatches: Map<string, TextMatch[]>,
  repoRoot: string,
): RegionSource {
  const elementSelector = el.id
    ? `#${el.id}`
    : el.classes.length > 0
      ? `${el.tag}${el.classes.map((c) => `.${c}`).join('')}`
      : el.tag;

  const matched: Array<{ sheetId: number; rule: ParsedRule }> = [];
  for (const [sheetId, sheet] of loaded) {
    for (const rule of sheet.rules) {
      if (
        selMatches[rule.selector] === true &&
        (rule.mediaChain === null || chainMatches[rule.mediaChain] === true)
      ) {
        matched.push({ sheetId, rule });
      }
    }
  }

  const rules: RuleEvidence[] = matched.map(({ sheetId, rule }) => {
    let source: SourceLocation | null = null;
    let confidence: Confidence = 'low';

    // 1) CSS source map.
    const sheet = loaded.get(sheetId);
    if (sheet?.map && sheet.segments) {
      const offset = takeOffset(sheetId, rule.selector);
      if (offset !== null) {
        const pos = mapOffset(sheet.segments, sheet.text, offset);
        const rawFile = pos ? sheet.map.sources[pos.sourceIndex] : undefined;
        if (rawFile) {
          source = {
            file: normalizeSourceFile(rawFile, sheet.baseUrl, repoRoot),
            line: pos!.line + 1,
            column: pos!.column + 1,
            via: 'source-map',
            gitignored: false,
          };
          confidence = 'high';
        }
      }
    }

    // 2) gitignore-aware text search fallback.
    if (!source) {
      const best = searchMatches.get(rule.selector)?.[0];
      if (best) {
        source = {
          file: best.file,
          line: best.line,
          column: best.column,
          via: 'text-search',
          gitignored: best.gitignored,
        };
        confidence = best.gitignored ? 'low' : 'medium';
      }
    }

    return {
      selector: rule.selector,
      media: rule.mediaChain,
      applies: rule.mediaChain === null || chainMatches[rule.mediaChain] === true,
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
): Promise<{ text: string; baseUrl: string | null } | null> {
  if (info.inlineText !== null) {
    return { text: info.inlineText, baseUrl: null };
  }
  if (info.href) {
    try {
      if (info.href.startsWith('file:')) {
        const text = await readFile(fileURLToPath(info.href), 'utf8');
        return { text, baseUrl: info.href };
      }
      const res = await fetch(info.href);
      if (!res.ok) return null;
      return { text: await res.text(), baseUrl: info.href };
    } catch {
      return null;
    }
  }
  return null;
}

async function loadMap(mapUrl: string, baseUrl: string | null): Promise<SourceMapV3 | null> {
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
      const data = await readFile(fileURLToPath(abs), 'utf8');
      return parseSourceMap(data);
    }
    const res = await fetch(abs);
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
 * Parse a stylesheet's text: every rule with its byte offset (for source-map
 * mapping), media condition chain, and visually relevant declarations.
 */
function parseRules(cssText: string): ParsedRule[] {
  let ast;
  try {
    ast = csstree.parse(cssText, { positions: true });
  } catch {
    return [];
  }
  const out: ParsedRule[] = [];
  const atRuleStack: string[] = [];
  const mediaChain = (): string | null => {
    const parts = atRuleStack.filter((c) => c !== '');
    return parts.length > 0 ? parts.join(' and ') : null;
  };
  csstree.walk(ast, {
    enter(node: csstree.CssNode) {
      if (node.type === 'Atrule') {
        const condition =
          node.name === 'media' || node.name === 'supports' || node.name === 'container'
            ? node.prelude
              ? csstree.generate(node.prelude)
              : ''
            : '';
        atRuleStack.push(condition);
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
          });
        }
        out.push({
          selector,
          offset: start,
          mediaChain: mediaChain(),
          properties,
          declared,
        });
      }
    },
    leave(node: csstree.CssNode) {
      if (node.type === 'Atrule') atRuleStack.pop();
    },
  });
  return out;
}
