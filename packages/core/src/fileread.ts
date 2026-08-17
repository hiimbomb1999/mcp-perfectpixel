/**
 * Shared, size-limited, mtime-checked cache for reading repo files — the
 * selector search and the design-token scan both walk the repo, so a single
 * cache means each file is stat'ed once and read at most once per capture.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;

interface Entry {
  mtimeMs: number;
  size: number;
  text: string | null; // null = too large / binary / unreadable
}

export class FileTextCache {
  private entries = new Map<string, Entry>();

  /**
   * Read a repo file as UTF-8 text (or null when too large / binary /
   * missing). Files bigger than the cap or containing NUL bytes in the first
   * 8KB are never read and cached as null.
   */
  async read(root: string, relPath: string): Promise<string | null> {
    const absPath = path.join(root, relPath);
    let st;
    try {
      st = await stat(absPath);
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
      buf = await readFile(absPath);
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

export const MAX_SCAN_FILE_BYTES = MAX_FILE_BYTES;
