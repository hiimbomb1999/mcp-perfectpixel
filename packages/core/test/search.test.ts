import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitignoreMatcher, searchSelectors } from '@mcp-perfectpixel/core';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'mcp-perfectpixel-search-'));
  await writeFile(
    path.join(root, '.gitignore'),
    ['dist/', '*.log', '!important.log', 'vendor/'].join('\n'),
  );
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'vendor'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(path.join(root, 'src', 'app.css'), '.button { color: red; }\n');
  await writeFile(path.join(root, 'dist', 'bundle.css'), '.button { color: red; }\n');
  await writeFile(path.join(root, 'vendor', 'lib.css'), '.header { color: blue; }\n');
  await writeFile(
    path.join(root, 'node_modules', 'pkg', 'index.css'),
    '.button { color: green; }\n',
  );
  await writeFile(path.join(root, 'app.log'), 'noise\n');
  await writeFile(path.join(root, 'important.log'), '.button { color: black; }\n');
  await writeFile(path.join(root, 'README.md'), 'see .button docs\n');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('GitignoreMatcher', () => {
  it('respects nested and negated patterns', async () => {
    const m = new GitignoreMatcher(root);
    expect(await m.isIgnored('dist/bundle.css')).toBe(true); // dist/
    expect(await m.isIgnored('app.log')).toBe(true); // *.log
    expect(await m.isIgnored('important.log')).toBe(false); // !important.log
    expect(await m.isIgnored('src/app.css')).toBe(false);
    expect(await m.isIgnored('vendor/lib.css')).toBe(true);
    expect(await m.isIgnored('node_modules/pkg/index.css')).toBe(true); // always ignored
  });
});

describe('searchSelectors', () => {
  it('reports non-ignored matches first, gitignored ones flagged', async () => {
    const results = await searchSelectors(root, ['.button', '.header']);
    const button = results.get('.button')!;
    expect(button.length).toBeGreaterThan(0);

    const nonIgnored = button.filter((m) => !m.gitignored);
    const ignored = button.filter((m) => m.gitignored);
    expect(nonIgnored.length).toBeGreaterThan(0); // src/app.css, README.md
    expect(ignored.length).toBeGreaterThan(0); // dist/bundle.css
    // Sorted: non-ignored first.
    expect(button[0]!.gitignored).toBe(false);
    // node_modules is never searched.
    expect(button.some((m) => m.file.startsWith('node_modules/'))).toBe(false);
    // .header only exists in vendor/ (gitignored) -> flagged as build output.
    const header = results.get('.header')!;
    expect(header.length).toBeGreaterThan(0);
    expect(header.every((m) => m.gitignored)).toBe(true);
  });

  it('returns no matches for selectors absent from the tree', async () => {
    const results = await searchSelectors(root, ['.nope-xyz']);
    expect(results.get('.nope-xyz')).toEqual([]);
  });

  it('reports line and column of the match', async () => {
    const results = await searchSelectors(root, ['.button']);
    const match = results.get('.button')!.find((m) => m.file === 'src/app.css')!;
    expect(match.line).toBe(1);
    expect(match.column).toBe(1);
  });
});
