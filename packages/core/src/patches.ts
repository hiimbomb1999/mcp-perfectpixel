/**
 * Goal 3 — minimal patch output, never a rewrite.
 *
 * For each diff region, derive the design's intended color from the design
 * image pixels, pick the SINGLE property most likely to have caused the diff
 * (background first, then text color, then borders/outline), resolve the CSS
 * cascade winner for that property (specificity, declaration order,
 * !important), and suggest the smallest change: `file:line:column`, `property`,
 * `current -> suggested`. When the suggested color matches a token the project
 * already defines (CSS custom properties, Tailwind config, style-dictionary
 * JSON), the token reference is suggested instead of a new hardcoded value.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { GitignoreMatcher } from './search.js';
import { compareSpecificity, type Specificity } from './css.js';
import type { Confidence, RgbaImage, SourceLocation } from './types.js';

/** Color-like properties a patch can target. */
const COLOR_PROPS = new Set([
  'background',
  'background-color',
  'color',
  'border-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline',
  'outline-color',
]);

/** Computed longhands checked, in preference order, to find the diff cause. */
const COMPUTED_COLOR_ORDER = [
  'background-color',
  'color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
];

/** Shorthands that cascade into each longhand (for winner lookup + patch). */
const SHORTHAND_COVER: Record<string, string[]> = {
  'background-color': ['background'],
  'border-top-color': ['border-color', 'border'],
  'border-right-color': ['border-color', 'border'],
  'border-bottom-color': ['border-color', 'border'],
  'border-left-color': ['border-color', 'border'],
  'outline-color': ['outline'],
};

export type TokenKind = 'css-variable' | 'tailwind' | 'style-dictionary';

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
   * The minimal suggested replacement: a token reference when the design color
   * matches a project token, otherwise the hex value derived from the design
   * image.
   */
  suggested: string;
  /** The normalized hex color the design image shows at the region. */
  value: string;
  /** The matched token, when one was preferred. */
  token: DesignToken | null;
  /** Inherited from the rule's source confidence. */
  confidence: Confidence;
}

/**
 * Sample the design image at a region and return the dominant opaque color as
 * a normalized hex. The bbox is shrunk by 2px so anti-aliased edges don't
 * pollute the histogram.
 */
export function sampleDesignColor(
  design: RgbaImage,
  region: { x: number; y: number; width: number; height: number },
): string | null {
  const x1 = Math.max(0, region.x + 2);
  const y1 = Math.max(0, region.y + 2);
  const x2 = Math.min(design.width - 1, region.x + region.width - 3);
  const y2 = Math.min(design.height - 1, region.y + region.height - 3);
  if (x2 < x1 || y2 < y1) return null;

  // 5-bit-per-channel histogram buckets.
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      const o = (y * design.width + x) * 4;
      const a = design.data[o + 3]!;
      if (a < 128) continue;
      const r = design.data[o]!;
      const g = design.data[o + 1]!;
      const b = design.data[o + 2]!;
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { count: 0, r: 0, g: 0, b: 0 };
        buckets.set(key, bucket);
      }
      bucket.count++;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
    }
  }
  let best: { count: number; r: number; g: number; b: number } | null = null;
  let bestCount = 0;
  for (const bucket of buckets.values()) {
    if (bucket.count > bestCount) {
      best = bucket;
      bestCount = bucket.count;
    }
  }
  if (!best) return null;
  return toHex(
    Math.round(best.r / best.count),
    Math.round(best.g / best.count),
    Math.round(best.b / best.count),
  );
}

/** Normalize a CSS color to lowercase `#rrggbb`, or null when unsupported. */
export function normalizeColor(value: string): string | null {
  const v = value.trim().toLowerCase();
  const hex3 = v.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (hex3) {
    return `#${hex3[1]}${hex3[1]}${hex3[2]}${hex3[2]}${hex3[3]}${hex3[3]}`;
  }
  const hex6 = v.match(/^#([0-9a-f]{6})$/);
  if (hex6) return `#${hex6[1]}`;
  const hex8 = v.match(/^#([0-9a-f]{8})$/);
  if (hex8) return `#${hex8[1]!.slice(0, 6)}`;
  const rgb = v.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (rgb) return toHex(+rgb[1]!, +rgb[2]!, +rgb[3]!);
  const rgba = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (rgba) {
    if (rgba[4] === undefined || parseFloat(rgba[4]) >= 0.999) {
      return toHex(+rgba[1]!, +rgba[2]!, +rgba[3]!);
    }
    return null; // translucent colors can't match solid tokens
  }
  const hsl = v.match(/^hsl\(\s*([\d.]+)\s*(?:deg)?\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/);
  if (hsl) {
    const [r, g, b] = hslToRgb(+hsl[1]!, +hsl[2]!, +hsl[3]!);
    return toHex(r, g, b);
  }
  return null;
}

/**
 * Scan `repoRoot` for design tokens: CSS custom properties, Tailwind configs,
 * and style-dictionary JSON. Gitignore-aware — build output is skipped.
 */
export async function findDesignTokens(repoRoot: string): Promise<DesignToken[]> {
  const matcher = new GitignoreMatcher(repoRoot);
  const tokens: DesignToken[] = [];
  await walkRepo(repoRoot, matcher, async (relPath, absPath) => {
    const lower = relPath.toLowerCase();
    if (/\.(css|scss|less|styl)$/.test(lower)) {
      await scanCssVariables(absPath, relPath, tokens);
    } else if (/tailwind\.config\./.test(lower) && /\.(js|cjs|mjs|ts)$/.test(lower)) {
      await scanTailwindConfig(absPath, relPath, tokens);
    } else if (/\.json$/.test(lower) && /token/.test(lower)) {
      await scanStyleDictionary(absPath, relPath, tokens);
    }
  });
  return tokens;
}

/** A matched rule with the cascade metadata patch selection needs. */
export interface PatchRuleInput {
  selector: string;
  specificity: Specificity;
  sheetId: number;
  index: number;
  important: ReadonlySet<string>;
  properties: string[];
  declared: Record<string, string>;
  source: SourceLocation | null;
  confidence: Confidence;
}

/**
 * Build at most ONE patch suggestion per region: the cascade-winning rule of
 * the single property most likely to have caused the diff.
 */
export function buildPatches(
  design: RgbaImage,
  region: { x: number; y: number; width: number; height: number },
  matched: PatchRuleInput[],
  elementComputed: Record<string, string>,
  tokens: DesignToken[],
): PatchSuggestion[] {
  const designHex = sampleDesignColor(design, region);
  if (!designHex || matched.length === 0) return [];
  const chosenProp = findCulpritProp(designHex, elementComputed, matched);
  if (chosenProp === null) return [];
  const tokensByValue = new Map<string, DesignToken[]>();
  for (const token of tokens) {
    const list = tokensByValue.get(token.value) ?? [];
    list.push(token);
    tokensByValue.set(token.value, list);
  }

  // Cascade winner for the chosen property.
  const winner = cascadeWinner(matched, chosenProp);
  if (!winner || !winner.source) return [];

  // The property as actually declared (longhand or covering shorthand).
  const declaredProp = declaredFor(winner, chosenProp);
  const current = declaredProp ? winner.declared[declaredProp] : undefined;
  if (current === undefined) return [];
  const currentHex = normalizeColor(current);
  if (currentHex === null || currentHex === designHex) return [];

  const token = preferToken(tokensByValue.get(designHex) ?? []);
  return [
    {
      file: winner.source.file,
      line: winner.source.line,
      column: winner.source.column,
      property: declaredProp ?? chosenProp,
      current,
      suggested: token ? token.reference : designHex,
      value: designHex,
      token,
      confidence: winner.confidence,
    },
  ];
}

/**
 * The single property most likely to have caused the diff: the first computed
 * color property that differs from the design color (background first, then
 * text color, borders, outline). Falls back to the declared property with the
 * largest color delta only when no computed value is parseable.
 */
export function findCulpritProp(
  designHex: string,
  elementComputed: Record<string, string>,
  matched: PatchRuleInput[],
): string | null {
  let sawParseableComputed = false;
  for (const prop of COMPUTED_COLOR_ORDER) {
    const computedVal = elementComputed[prop];
    if (!computedVal) continue;
    const norm = normalizeColor(computedVal);
    if (norm === null) continue; // e.g. transparent / gradient — no pixel anchor
    sawParseableComputed = true;
    if (norm !== designHex) return prop;
  }
  // Fallback only when computed values are unavailable (nothing to compare).
  if (!sawParseableComputed) {
    let bestProp: string | null = null;
    let bestDelta = -1;
    for (const m of matched) {
      for (const prop of m.properties) {
        if (!COLOR_PROPS.has(prop)) continue;
        const norm = normalizeColor(m.declared[prop] ?? '');
        if (norm === null || norm === designHex) continue;
        const delta = colorDistance(norm, designHex);
        if (delta > bestDelta) {
          bestDelta = delta;
          bestProp = prop;
        }
      }
    }
    return bestProp;
  }
  return null;
}

/** Properties inherited from ancestors (relevant when nothing declares them). */
const INHERITED_COLOR_PROPS = new Set(['color']);

/**
 * Explain why a region produced no patch, without guessing a file: when the
 * culprit property is inherited (e.g. `color`) and no rule on the element
 * declares it, the fix lives on an ancestor — say so with the parent's
 * computed value as evidence.
 */
export function inheritanceNotes(
  design: RgbaImage,
  region: { x: number; y: number; width: number; height: number },
  elementComputed: Record<string, string>,
  parentComputed: Record<string, string>,
): string[] {
  const designHex = sampleDesignColor(design, region);
  if (!designHex) return [];
  const notes: string[] = [];
  for (const prop of INHERITED_COLOR_PROPS) {
    const elVal = elementComputed[prop];
    if (!elVal) continue;
    const norm = normalizeColor(elVal);
    if (norm === null || norm === designHex) continue; // not the culprit
    const parentVal = parentComputed[prop];
    if (parentVal !== undefined && parentVal !== elVal) {
      notes.push(
        `"${prop}" differs from the design (computed ${elVal} here, ${parentVal} on the parent) ` +
          'but no rule on this element declares it — the value is inherited; ' +
          'the fix likely belongs to a rule targeting an ancestor.',
      );
    } else {
      notes.push(
        `"${prop}" differs from the design but no rule on this element declares it — ` +
          'the value is likely inherited from an ancestor rule.',
      );
    }
  }
  return notes;
}

/** The property name a rule declares that covers `prop` (or null). */
function declaredFor(rule: PatchRuleInput, prop: string): string | null {
  if (rule.declared[prop] !== undefined) return prop;
  for (const cover of SHORTHAND_COVER[prop] ?? []) {
    if (rule.declared[cover] !== undefined) return cover;
  }
  return null;
}

/**
 * The rule that wins the cascade for `prop` among the matched rules:
 * !important beats normal, then highest specificity, then latest in document
 * order (sheet order, then rule index). Shorthand declarations participate in
 * the cascade of the longhands they cover.
 */
export function cascadeWinner(matched: PatchRuleInput[], prop: string): PatchRuleInput | null {
  const covers = SHORTHAND_COVER[prop] ?? [];
  const participates = (m: PatchRuleInput): boolean =>
    m.declared[prop] !== undefined || covers.some((c) => m.declared[c] !== undefined);
  const isImportant = (m: PatchRuleInput): boolean =>
    m.important.has(prop) || covers.some((c) => m.important.has(c));

  let winner: PatchRuleInput | null = null;
  for (const m of matched) {
    if (!participates(m)) continue;
    if (!winner) {
      winner = m;
      continue;
    }
    const impM = isImportant(m);
    const impW = isImportant(winner);
    if (impM !== impW) {
      if (impM) winner = m;
      continue;
    }
    const cmp = compareSpecificity(m.specificity, winner.specificity);
    if (cmp > 0) {
      winner = m;
      continue;
    }
    if (cmp < 0) continue;
    if (m.sheetId > winner.sheetId || (m.sheetId === winner.sheetId && m.index > winner.index)) {
      winner = m;
    }
  }
  return winner;
}

function colorDistance(a: string, b: string): number {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return Math.sqrt((ar - br) ** 2 + (ag - bg) ** 2 + (ab - bb) ** 2);
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Pick the most directly usable token among matches. */
function preferToken(candidates: DesignToken[]): DesignToken | null {
  if (candidates.length === 0) return null;
  // CSS custom properties are the most portable reference (var(--x)); then
  // style-dictionary names; tailwind last (framework-specific usage).
  const rank: Record<TokenKind, number> = {
    'css-variable': 0,
    'style-dictionary': 1,
    tailwind: 2,
  };
  return [...candidates].sort((a, b) => rank[a.kind] - rank[b.kind])[0]!;
}

function toHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return '#' + [clamp(r), clamp(g), clamp(b)].map((n) => n.toString(16).padStart(2, '0')).join('');
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const light = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

async function scanCssVariables(
  absPath: string,
  relPath: string,
  tokens: DesignToken[],
): Promise<void> {
  const text = await readText(absPath);
  if (!text) return;
  const re = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;{}]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const value = normalizeColor(m[2]!);
    if (!value) continue;
    const name = m[1]!;
    tokens.push({
      name,
      reference: `var(${name})`,
      value,
      file: relPath,
      line: lineOf(text, m.index),
      kind: 'css-variable',
    });
  }
}

async function scanTailwindConfig(
  absPath: string,
  relPath: string,
  tokens: DesignToken[],
): Promise<void> {
  const text = await readText(absPath);
  if (!text) return;
  const re =
    /['"]?([a-zA-Z0-9_-]+)['"]?\s*:\s*['"](#[0-9a-fA-F]{3,8}|rgb\([^)]*\)|hsl\([^)]*\))['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const value = normalizeColor(m[2]!);
    if (!value) continue;
    const name = m[1]!;
    tokens.push({
      name,
      reference: name,
      value,
      file: relPath,
      line: lineOf(text, m.index),
      kind: 'tailwind',
    });
  }
}

async function scanStyleDictionary(
  absPath: string,
  relPath: string,
  tokens: DesignToken[],
): Promise<void> {
  const text = await readText(absPath);
  if (!text) return;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return;
  }
  const walk = (node: unknown, prefix: string): void => {
    if (node === null || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.value === 'string') {
      const value = normalizeColor(obj.value);
      if (value && prefix !== '') {
        tokens.push({
          name: prefix,
          reference: prefix,
          value,
          file: relPath,
          line: lineOf(text, text.indexOf(obj.value)),
          kind: 'style-dictionary',
        });
      }
    }
    for (const [key, child] of Object.entries(obj)) {
      if (child !== null && typeof child === 'object') {
        walk(child, prefix === '' ? key : `${prefix}.${key}`);
      }
    }
  };
  walk(json, '');
}

async function readText(absPath: string): Promise<string | null> {
  try {
    const size = (await stat(absPath)).size;
    if (size > 5 * 1024 * 1024) return null; // check with stat() before reading
    const buf = await readFile(absPath);
    if (buf.length > 0 && buf.subarray(0, 8192).includes(0)) return null; // binary
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

async function walkRepo(
  root: string,
  matcher: GitignoreMatcher,
  visit: (relPath: string, absPath: string) => Promise<void>,
): Promise<void> {
  const walk = async (dirRel: string): Promise<void> => {
    const absDir = path.join(root, dirRel);
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = dirRel === '' ? entry.name : `${dirRel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        if (await matcher.isIgnored(rel)) continue;
        await walk(rel);
      } else if (entry.isFile()) {
        if (await matcher.isIgnored(rel)) continue;
        await visit(rel, path.join(root, rel));
      }
    }
  };
  await walk('');
}
