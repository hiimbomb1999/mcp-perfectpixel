/**
 * Gitignore-aware text search — a ripgrep-like fallback for source tracing.
 * Walk the repo with the same semantics as ripgrep: `.gitignore` files are
 * respected (including nested ones and negations) so node_modules, dist,
 * vendor, and other generated directories are never searched; matches inside
 * gitignored paths are still reported but flagged so they can be
 * deprioritized (build output, not the real source).
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { FileTextCache } from './fileread.js';
import type { Platform } from './types.js';

export type MatchContext =
  'source-css' | 'source' | 'test' | 'docs' | 'generated' | 'liquid-schema' | 'vue-sfc-style';

export interface TextMatch {
  /** Path relative to the search root. */
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  /** The matching line, trimmed. */
  lineText: string;
  gitignored: boolean;
  /**
   * Where the match lives: stylesheet-family source, other source, tests,
   * docs/examples/fixtures, or generated/build output. Used to rank matches
   * and lower confidence for non-source contexts.
   */
  context: MatchContext;
  /** Whether the match looks like a CSS rule header (`selector {` / `selector,`). */
  ruleHeader: boolean;
}

const ALWAYS_IGNORED_DIRS = new Set(['.git', 'node_modules']);

const MAX_MATCHES_PER_SELECTOR = 25;

const CSS_EXT = /\.(css|scss|less|styl)$/i;
const TEST_PATH = /(^|\/)(__tests__|tests?|specs?)(\/|\.)/i;
const DOCS_PATH = /(^|\/)(docs?|examples?|fixtures?)(\/|$)/i;
const DOCS_FILE = /(^|\/)(readme|changelog|changes?|license|contributing)(\.|$)/i;
const GENERATED_PATH = /(^|\/)(node_modules|dist|build|vendor|coverage)(\/|$)/i;
const GENERATED_FILE = /\.(min|bundle|chunk)\./i;

/** Classify where a repo-relative match lives. */
export function classifyMatch(file: string): MatchContext {
  const lower = file.toLowerCase();
  if (GENERATED_PATH.test(lower) || GENERATED_FILE.test(lower)) return 'generated';
  if (TEST_PATH.test(lower) || /\.(test|spec)\./.test(lower)) return 'test';
  if (DOCS_PATH.test(lower) || DOCS_FILE.test(lower)) return 'docs';
  if (/\.liquid$/i.test(lower)) return 'liquid-schema';
  if (/\.vue$/i.test(lower)) return 'vue-sfc-style';
  if (CSS_EXT.test(lower)) return 'source-css';
  return 'source';
}

/** Priority include-globs per platform — matches rank first, others are not excluded. */
const PLATFORM_GLOBS: Record<Exclude<Platform, 'auto'>, string[]> = {
  shopify: ['sections/', 'snippets/', 'assets/*.css', 'assets/*.scss'],
  bigcommerce: ['templates/', 'assets/scss/', 'assets/js/'],
  react: ['src/', '**/*.module.css'],
  vue: ['**/*.vue'],
  'html-tailwind': ['**/*.html', 'tailwind.config.'],
};

/** Does a repo-relative path match any of the platform's priority globs? */
export function matchesPlatformGlobs(file: string, platform: Platform | undefined): boolean {
  if (!platform || platform === 'auto') return false;
  const lower = file.toLowerCase();
  return (PLATFORM_GLOBS[platform] ?? []).some((glob) => {
    if (glob.endsWith('/')) return lower.startsWith(glob.toLowerCase());
    if (glob.includes('*')) {
      // e.g. assets/*.css or **/*.vue — match the tail, allow any leading dirs.
      const tail = glob.split('*').pop()!.toLowerCase();
      return lower.endsWith(tail);
    }
    return lower.includes(glob.toLowerCase());
  });
}

/**
 * Detect the platform from repo markers (cheap shallow scan, depth ≤ 2):
 * any *.liquid → shopify; stencil.conf.json or templates/ → bigcommerce;
 * package.json deps → vue/react; tailwind config alone → html-tailwind.
 */
export async function detectPlatform(root: string): Promise<Exclude<Platform, 'auto'> | undefined> {
  // Collect file names at depth 1 and 2 (enough for sections/*.liquid etc.).
  const names: string[] = [];
  const scan = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (entry.isFile()) names.push(entry.name.toLowerCase());
      else if (depth < 2) await scan(path.join(dir, entry.name), depth + 1);
    }
  };
  await scan(root, 0);

  if (names.some((n) => n.endsWith('.liquid'))) return 'shopify';
  if (names.includes('stencil.conf.json')) return 'bigcommerce';
  const hasTemplates = names.includes('templates');
  const hasAssets = names.includes('assets');
  const tailwind = names.some((n) => n.startsWith('tailwind.config.'));
  if (names.includes('package.json')) {
    try {
      const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps['vue']) return 'vue';
      if (deps['react']) return 'react';
      if (tailwind && !deps['react']) return 'html-tailwind';
    } catch {
      // fall through
    }
  }
  if (hasTemplates || hasAssets) return 'bigcommerce';
  if (tailwind) return 'html-tailwind';
  return undefined;
}

/** Does the matched line look like a CSS rule header (selector followed by { or ,)? */
function looksLikeRuleHeader(lineText: string, selector: string): boolean {
  const trimmed = lineText.trim();
  if (/[{,]\s*$/.test(trimmed)) return true;
  const idx = trimmed.indexOf(selector);
  if (idx === -1) return false;
  const after = trimmed.slice(idx + selector.length).replace(/^\s+/, '');
  return after.startsWith('{') || after.startsWith(',');
}

/** Tests a path (relative to the search root) against every applicable .gitignore. */
export class GitignoreMatcher {
  private readonly root: string;
  private readonly ignoreCache = new Map<string, Ignore>();

  constructor(root: string) {
    this.root = root;
  }

  /** Create (and cache) an Ignore instance for a directory's .gitignore. */
  private async ignoreForDir(dirRel: string): Promise<Ignore> {
    let ig = this.ignoreCache.get(dirRel);
    if (ig) return ig;
    ig = ignore();
    const gitignorePath = path.join(this.root, dirRel, '.gitignore');
    try {
      const content = await readFile(gitignorePath, 'utf8');
      ig.add(content.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trim().startsWith('#')));
    } catch {
      // No .gitignore in this directory.
    }
    this.ignoreCache.set(dirRel, ig);
    return ig;
  }

  /**
   * Is `relPath` ignored? Tests the path against the .gitignore of every
   * ancestor directory (rules in dir D apply to paths relative to D).
   */
  async isIgnored(relPath: string): Promise<boolean> {
    if (relPath === '' || relPath === '.') return false;
    const parts = relPath.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      const dirRel = parts.slice(0, depth).join('/');
      if (ALWAYS_IGNORED_DIRS.has(dirRel)) return true;
      const ig = await this.ignoreForDir(dirRel);
      const relToDir = parts.slice(depth).join('/');
      if (relToDir !== '' && ig.ignores(relToDir)) return true;
    }
    // The root .gitignore also applies to the path itself.
    const rootIg = await this.ignoreForDir('.');
    return rootIg.ignores(relPath);
  }
}

interface FileHit {
  relPath: string;
  gitignored: boolean;
  context: MatchContext;
  lines: Array<{ line: number; column: number; lineText: string; ruleHeader: boolean }>;
}

/**
 * Search `root` for the given selector strings (e.g. `.button`, `#header`),
 * respecting .gitignore. Returns selectors -> matches, best first:
 * non-ignored over gitignored, platform-priority globs first, stylesheet-family
 * source over other source over tests/docs, rule-header matches over bare
 * substrings, and (when `near` is given) matches sharing the deepest directory
 * prefix with it.
 */
export async function searchSelectors(
  root: string,
  selectors: string[],
  near?: string,
  cache: FileTextCache = new FileTextCache(),
  platform?: Platform,
): Promise<Map<string, TextMatch[]>> {
  const matcher = new GitignoreMatcher(root);
  const wanted = new Set(selectors.filter((s) => s.length > 0));
  const results = new Map<string, FileHit[]>();
  for (const s of wanted) results.set(s, []);

  await walk(root, '', matcher, results, wanted, cache);

  const nearDir = near ? path.posix.dirname(near) : '';
  const contextRank: Record<MatchContext, number> = {
    'source-css': 0,
    'liquid-schema': 0,
    'vue-sfc-style': 0,
    source: 1,
    test: 2,
    docs: 3,
    generated: 4,
  };

  const out = new Map<string, TextMatch[]>();
  for (const selector of wanted) {
    const hits = results.get(selector)!;
    hits.sort((a, b) => {
      if (Number(a.gitignored) !== Number(b.gitignored)) {
        return Number(a.gitignored) - Number(b.gitignored);
      }
      // Platform-priority globs rank before everything else.
      const plat =
        Number(matchesPlatformGlobs(b.relPath, platform)) -
        Number(matchesPlatformGlobs(a.relPath, platform));
      if (plat !== 0) return plat;
      const ctx = contextRank[a.context] - contextRank[b.context];
      if (ctx !== 0) return ctx;
      const dist = directoryDistance(b.relPath, nearDir) - directoryDistance(a.relPath, nearDir);
      if (dist !== 0) return dist;
      return 0;
    });
    const matches: TextMatch[] = [];
    for (const hit of hits) {
      for (const m of hit.lines) {
        matches.push({
          file: hit.relPath,
          line: m.line,
          column: m.column,
          lineText: m.lineText,
          gitignored: hit.gitignored,
          context: hit.context,
          ruleHeader: m.ruleHeader,
        });
        if (matches.length >= MAX_MATCHES_PER_SELECTOR) break;
      }
      if (matches.length >= MAX_MATCHES_PER_SELECTOR) break;
    }
    // Within the same file, rule-header lines come before bare substrings.
    matches.sort((a, b) => Number(b.ruleHeader) - Number(a.ruleHeader));
    out.set(selector, matches);
  }
  return out;
}

/** Directory-prefix distance between a match path and a reference directory. */
function directoryDistance(file: string, nearDir: string): number {
  if (!nearDir) return 0;
  const parts = file.split('/');
  parts.pop(); // drop the file name
  const ref = nearDir.split('/').filter(Boolean);
  let common = 0;
  for (let i = 0; i < Math.min(parts.length, ref.length); i++) {
    if (parts[i] === ref[i]) common++;
    else break;
  }
  return parts.length - common;
}

/** Max concurrent file reads during a repo walk. */
const SCAN_CONCURRENCY = 16;

async function walk(
  root: string,
  dirRel: string,
  matcher: GitignoreMatcher,
  results: Map<string, FileHit[]>,
  wanted: Set<string>,
  cache: FileTextCache,
): Promise<void> {
  if (saturated(results, wanted)) return;
  // Collect candidate files first (cheap readdirs), then scan them with a
  // bounded worker pool so big repos don't serialize every file read.
  const files: string[] = [];
  const collect = async (rel: string): Promise<void> => {
    const absDir = path.join(root, rel);
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        // .git and node_modules are never worth searching — the one hard skip
        // (mirrors ripgrep's --glob '!node_modules'). Everything else is walked
        // and flagged gitignored so build-output matches are deprioritized.
        if (ALWAYS_IGNORED_DIRS.has(entry.name)) continue;
        await collect(child);
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  };
  await collect(dirRel);

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length && !saturated(results, wanted)) {
      const rel = files[next]!;
      next++;
      await scanFile(root, rel, matcher, results, wanted, cache);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SCAN_CONCURRENCY, Math.max(1, files.length)) }, () => worker()),
  );
}

/** True when every selector already has enough non-ignored matches. */
function saturated(results: Map<string, FileHit[]>, wanted: Set<string>): boolean {
  for (const selector of wanted) {
    const hits = results.get(selector)!;
    const nonIgnored = hits.filter((h) => !h.gitignored).length;
    if (nonIgnored < MAX_MATCHES_PER_SELECTOR) return false;
  }
  return true;
}

async function scanFile(
  root: string,
  relPath: string,
  matcher: GitignoreMatcher,
  results: Map<string, FileHit[]>,
  wanted: Set<string>,
  cache: FileTextCache,
): Promise<void> {
  // Shared cache: stat'ed once, read at most once per capture (the token scan
  // reuses the same cache). Huge/binary files are never read.
  const text = await cache.read(root, relPath);
  if (text === null) return;
  // Fast path: nothing to look for in this file.
  let any = false;
  for (const s of wanted) {
    if (text.includes(s)) {
      any = true;
      break;
    }
  }
  if (!any) return;

  const gitignored = await matcher.isIgnored(relPath);
  const context = classifyMatch(relPath);
  const lines = text.split(/\r?\n/);
  for (const selector of wanted) {
    const fileHits = results.get(selector)!;
    const nonIgnoredCount = fileHits.filter((h) => !h.gitignored).length;
    // Enough good (non-ignored) matches already — nothing more needed.
    if (nonIgnoredCount >= MAX_MATCHES_PER_SELECTOR) continue;
    // Gitignored matches only fill in when there are few non-ignored ones, so a
    // huge ignored cache (dist/, .pnpm-store/) can never crowd out the real
    // source matches that appear later in the walk.
    if (gitignored && fileHits.length >= MAX_MATCHES_PER_SELECTOR * 2) continue;
    const hits: Array<{ line: number; column: number; lineText: string; ruleHeader: boolean }> = [];
    for (let i = 0; i < lines.length && hits.length < 5; i++) {
      const lineText = lines[i]!;
      let idx = lineText.indexOf(selector);
      while (idx !== -1 && hits.length < 5) {
        hits.push({
          line: i + 1,
          column: idx + 1,
          lineText: lineText.trim().slice(0, 160),
          ruleHeader: looksLikeRuleHeader(lineText, selector),
        });
        idx = lineText.indexOf(selector, idx + selector.length);
      }
    }
    if (hits.length > 0) {
      fileHits.push({ relPath, gitignored, context, lines: hits });
    }
  }
}
