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
}

const ALWAYS_IGNORED_DIRS = new Set(['.git', 'node_modules']);

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_MATCHES_PER_SELECTOR = 25;
const BINARY_SNIFF_BYTES = 8192;

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
  lines: Array<{ line: number; column: number; lineText: string }>;
}

/**
 * Search `root` for the given selector strings (e.g. `.button`, `#header`),
 * respecting .gitignore. Returns selectors -> matches, best (non-ignored)
 * matches first.
 */
export async function searchSelectors(
  root: string,
  selectors: string[],
): Promise<Map<string, TextMatch[]>> {
  const matcher = new GitignoreMatcher(root);
  const wanted = new Set(selectors.filter((s) => s.length > 0));
  const results = new Map<string, FileHit[]>();
  for (const s of wanted) results.set(s, []);

  await walk(root, '', matcher, results, wanted);

  const out = new Map<string, TextMatch[]>();
  for (const selector of wanted) {
    const hits = results.get(selector)!;
    // Non-ignored (likely source) matches first, then gitignored (build output).
    hits.sort((a, b) => Number(a.gitignored) - Number(b.gitignored));
    const matches: TextMatch[] = [];
    for (const hit of hits) {
      for (const m of hit.lines) {
        matches.push({
          file: hit.relPath,
          line: m.line,
          column: m.column,
          lineText: m.lineText,
          gitignored: hit.gitignored,
        });
        if (matches.length >= MAX_MATCHES_PER_SELECTOR) break;
      }
      if (matches.length >= MAX_MATCHES_PER_SELECTOR) break;
    }
    out.set(selector, matches);
  }
  return out;
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
  let stat;
  try {
    stat = await readFile(absPath);
  } catch {
    return;
  }
  if (stat.length > MAX_FILE_BYTES) return;
  if (stat.length > 0 && stat.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return; // binary

  let text: string;
  try {
    text = stat.toString('utf8');
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
    const hits: Array<{ line: number; column: number; lineText: string }> = [];
    for (let i = 0; i < lines.length && hits.length < 5; i++) {
      const lineText = lines[i]!;
      let idx = lineText.indexOf(selector);
      while (idx !== -1 && hits.length < 5) {
        hits.push({ line: i + 1, column: idx + 1, lineText: lineText.trim().slice(0, 160) });
        idx = lineText.indexOf(selector, idx + selector.length);
      }
    }
    if (hits.length > 0) {
      fileHits.push({ relPath, gitignored, lines: hits });
    }
  }
}
