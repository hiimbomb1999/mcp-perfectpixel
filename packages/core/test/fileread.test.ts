import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileTextCache, trimComputedStyle } from '@mcp-perfectpixel/core';

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
});
