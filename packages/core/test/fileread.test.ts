import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileTextCache, responsiveNotes, trimComputedStyle } from '@mcp-perfectpixel/core';

describe('trimComputedStyle', () => {
  const FULL = {
    'background-color': 'rgb(220, 38, 38)',
    color: 'rgb(0, 0, 0)',
    'border-top-width': '0px',
    'border-top-style': 'none',
    'border-top-color': 'rgb(0, 0, 0)',
    'margin-top': '0px',
    width: '120px',
    height: '36px',
    'font-size': '16px',
    opacity: '1',
    transform: 'none',
  };
  const PARENT = {
    'background-color': 'rgb(248, 250, 252)',
    color: 'rgb(0, 0, 0)',
    'border-top-width': '0px',
    'border-top-style': 'none',
    'border-top-color': 'rgb(0, 0, 0)',
    'margin-top': '0px',
    width: '200px',
    height: '120px',
    'font-size': '16px',
    opacity: '1',
    transform: 'none',
  };

  it('keeps color candidates plus values that differ from the parent', () => {
    const out = trimComputedStyle(FULL, PARENT, 'minimal');
    // Color candidates always kept.
    expect(out['background-color']).toBe('rgb(220, 38, 38)');
    expect(out.color).toBe('rgb(0, 0, 0)');
    expect(out['border-top-color']).toBe('rgb(0, 0, 0)');
    // Values differing from the parent are kept (this element's own styling).
    expect(out.width).toBe('120px');
    expect(out.height).toBe('36px');
    // Default noise equal to the parent is dropped.
    expect(out['border-top-width']).toBeUndefined();
    expect(out['margin-top']).toBeUndefined();
    expect(out['font-size']).toBeUndefined();
    expect(out.opacity).toBeUndefined();
  });

  it('supports full and none modes', () => {
    expect(Object.keys(trimComputedStyle(FULL, PARENT, 'full'))).toHaveLength(
      Object.keys(FULL).length,
    );
    expect(trimComputedStyle(FULL, PARENT, 'none')).toEqual({});
  });
});

describe('responsiveNotes (avoid hardcoding width/height)', () => {
  const FIXED = { computed: { width: '120px', height: '36px' } };
  const FLUID = { computed: { width: 'auto', height: 'auto' } };

  it('warns against hardcoding dims when the page is responsive and dims are fixed', () => {
    const notes = responsiveNotes(800, FIXED, { mediaQueries: 3, containerQueries: 1 }, true);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/do NOT hardcode width\/height/);
    expect(notes[0]).toContain('120px×36px');
    expect(notes[0]).toContain('3 @media');
  });

  it('warns on geometry-only diffs (no color patch) with fixed dims', () => {
    const notes = responsiveNotes(800, FIXED, { mediaQueries: 0, containerQueries: 0 }, false);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/layout\/spacing/);
    expect(notes[0]).toMatch(/fluid layout/);
  });

  it('stays silent for fluid elements with a patch and no breakpoints', () => {
    expect(responsiveNotes(800, FLUID, { mediaQueries: 0, containerQueries: 0 }, true)).toEqual([]);
  });

  it('stays silent for fluid elements even on a responsive page', () => {
    expect(responsiveNotes(800, FLUID, { mediaQueries: 4, containerQueries: 0 }, true)).toEqual([]);
  });
});

describe('FileTextCache', () => {
  it('reads once and reuses until the file changes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-perfectpixel-cache-'));
    const file = path.join(dir, 'a.css');
    await writeFile(file, '.a { color: red; }');
    const cache = new FileTextCache();
    expect(await cache.read(dir, 'a.css')).toBe('.a { color: red; }');
    // Same mtime/size -> cached, no re-read.
    expect(await cache.read(dir, 'a.css')).toBe('.a { color: red; }');
    // Change content (size differs) -> re-read.
    await writeFile(file, '.a { color: blue; }\n');
    expect(await cache.read(dir, 'a.css')).toBe('.a { color: blue; }\n');
    // Missing file -> null.
    expect(await cache.read(dir, 'nope.css')).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it('caches oversized/binary files as null without reading them', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-perfectpixel-cache2-'));
    await writeFile(path.join(dir, 'huge.bin'), Buffer.alloc(6 * 1024 * 1024, 0x61));
    await writeFile(path.join(dir, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    const cache = new FileTextCache();
    expect(await cache.read(dir, 'huge.bin')).toBeNull();
    expect(await cache.read(dir, 'img.png')).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves repeated reads from cache and invalidates on mtime change (session cache)', async () => {
    const readFn = vi.fn(async () => Buffer.from('hello'));
    let mtime = 1;
    const statFn = vi.fn(async () => ({ size: 5, mtimeMs: mtime }));
    const cache = new FileTextCache(readFn, statFn);

    expect(await cache.read('/repo', 'a.txt')).toBe('hello');
    expect(await cache.read('/repo', 'a.txt')).toBe('hello');
    expect(readFn).toHaveBeenCalledTimes(1); // second call served from cache

    mtime = 2; // file changed on disk
    expect(await cache.read('/repo', 'a.txt')).toBe('hello');
    expect(readFn).toHaveBeenCalledTimes(2); // re-read after invalidation
  });
});
