/**
 * Shared, size-limited, mtime-checked cache for reading repo files — the
 * selector search and the design-token scan both walk the repo, so a single
 * cache means each file is stat'ed once and read at most once per capture.
 *
 * The default instance (`sharedFileTextCache`) lives for the whole process, so
 * consecutive `capture_and_diff` calls in a long-lived MCP server reuse the
 * previous reads (files are re-stat'ed on every call; only changed files are
 * re-read — invalidated by mtime + size).
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;

export interface FileStat {
  size: number;
  mtimeMs: number;
}

interface Entry {
  mtimeMs: number;
  size: number;
  text: string | null; // null = too large / binary / unreadable
}

export class FileTextCache {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly readFn: (p: string) => Promise<Buffer> = readFile,
    private readonly statFn: (p: string) => Promise<FileStat> = stat,
  ) {}

  /**
   * Read a repo file as UTF-8 text (or null when too large / binary /
   * missing). Files bigger than the cap or containing NUL bytes in the first
   * 8KB are never read and cached as null.
   */
  async read(root: string, relPath: string): Promise<string | null> {
    const absPath = path.join(root, relPath);
    let st: FileStat;
    try {
      st = await this.statFn(absPath);
    } catch {
      return null;
    }
    const cached = this.entries.get(absPath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.text;
    }
    if (st.size > MAX_FILE_BYTES) {
      this.entries.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, text: null });
      return null;
    }
    let buf: Buffer;
    try {
      buf = await this.readFn(absPath);
    } catch {
      this.entries.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, text: null });
      return null;
    }
    if (buf.length > 0 && buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      this.entries.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, text: null });
      return null;
    }
    const text = buf.toString('utf8');
    this.entries.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, text });
    return text;
  }
}

/** Process-wide default: consecutive captures reuse previously read files. */
export const sharedFileTextCache = new FileTextCache();

export const MAX_SCAN_FILE_BYTES = MAX_FILE_BYTES;
