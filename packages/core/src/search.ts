/**
 * Gitignore-aware text search — a ripgrep-like fallback for source tracing.
 * Walk the repo with the same semantics as ripgrep: `.gitignore` files are
 * respected (including nested ones and negations) so node_modules, dist,
 * vendor, and other generated directories are never searched; matches inside
 * gitignored paths are still reported but flagged so they can be
 * deprioritized (build output, not the real source).
 */
import { readdir, readFile, stat as fstat } from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';

export type MatchContext = 'source-css' | 'source' | 'test' | 'docs' | 'generated';

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

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_MATCHES_PER_SELECTOR = 25;
const BINARY_SNIFF_BYTES = 8192;

const CSS_EXT = /\.(css|scss|less|styl)$/i;
const TEST_PATH = /(^|\/)(__tests__|tests?|specs?)(\/|\.)/i;
const DOCS_PATH = /(^|\/)(docs?|examples?|fixtures?|templates?)(\/|$)/i;
const DOCS_FILE = /(^|\/)(readme|changelog|changes?|license|contributing)(\.|$)/i;
const GENERATED_PATH = /(^|\/)(node_modules|dist|build|vendor|coverage)(\/|$)/i;
const GENERATED_FILE = /\.(min|bundle|chunk)\./i;

/** Classify where a repo-relative match lives. */
export function classifyMatch(file: string): MatchContext {
  const lower = file.toLowerCase();
  if (GENERATED_PATH.test(lower) || GENERATED_FILE.test(lower)) return 'generated';
  if (TEST_PATH.test(lower) || /\.(test|spec)\./.test(lower)) return 'test';
  if (DOCS_PATH.test(lower) || DOCS_FILE.test(lower)) return 'docs';
  if (CSS_EXT.test(lower)) return 'source-css';
  return 'source';
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
 * non-ignored over gitignored, stylesheet-family source over other source
 * over tests/docs, rule-header matches over bare substrings, and (when `near`
 * is given) matches sharing the deepest directory prefix with it.
 */
export async function searchSelectors(
  root: string,
  selectors: string[],
  near?: string,
): Promise<Map<string, TextMatch[]>> {
  const matcher = new GitignoreMatcher(root);
  const wanted = new Set(selectors.filter((s) => s.length > 0));
  const results = new Map<string, FileHit[]>();
  for (const s of wanted) results.set(s, []);

  await walk(root, '', matcher, results, wanted);

  const nearDir = near ? path.posix.dirname(near) : '';
  const contextRank: Record<MatchContext, number> = {
    'source-css': 0,
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

async function walk(
  root: string,
  dirRel: string,
  matcher: GitignoreMatcher,
  results: Map<string, FileHit[]>,
  wanted: Set<string>,
): Promise<void> {
  if (saturated(results, wanted)) return;
  const absDir = path.join(root, dirRel);
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (saturated(results, wanted)) return;
    const rel = dirRel === '' ? entry.name : `${dirRel}/${entry.name}`;
    if (entry.isDirectory()) {
      // .git and node_modules are never worth searching — this is the one
      // hard skip (mirrors ripgrep's --glob '!node_modules'). Everything else
      // (dist/, build/, vendor/, ...) is walked and flagged gitignored so
      // build-output matches are reported but deprioritized.
      if (ALWAYS_IGNORED_DIRS.has(entry.name)) continue;
      await walk(root, rel, matcher, results, wanted);
    } else if (entry.isFile()) {
      await scanFile(root, rel, matcher, results, wanted);
    }
  }
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
): Promise<void> {
  const absPath = path.join(root, relPath);
  // Check size with stat() BEFORE reading, so huge files never get loaded.
  let size: number;
  try {
    size = (await fstat(absPath)).size;
  } catch {
    return;
  }
  if (size > MAX_FILE_BYTES) return;
  let buffer: Buffer;
  try {
    buffer = await readFile(absPath);
  } catch {
    return;
  }
  if (buffer.length > 0 && buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return; // binary

  let text: string;
  try {
    text = buffer.toString('utf8');
  } catch {
    return;
  }
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
