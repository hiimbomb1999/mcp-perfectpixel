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
  // A file too big to scan (checked with stat() before reading).
  await writeFile(path.join(root, 'src', 'huge.bin'), Buffer.alloc(6 * 1024 * 1024, 0x62));
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
    // css-family matches are classified as source-css.
    expect(match.context).toBe('source-css');
    expect(match.ruleHeader).toBe(true); // ".button {"
  });

  it('ranks rule-header matches over bare substrings and marks contexts', async () => {
    const results = await searchSelectors(root, ['.button']);
    const button = results.get('.button')!;
    // src/app.css has ".button {" (rule header, source-css) — ranked first.
    expect(button[0]!.file).toBe('src/app.css');
    expect(button[0]!.ruleHeader).toBe(true);
    // README.md match is a bare substring in docs context.
    const readme = button.find((m) => m.file === 'README.md')!;
    expect(readme.context).toBe('docs');
    expect(readme.ruleHeader).toBe(false);
  });

  it('skips files larger than the scan limit (stat before read)', async () => {
    const results = await searchSelectors(root, ['.button']);
    expect(results.get('.button')!.some((m) => m.file === 'src/huge.bin')).toBe(false);
  });
});

describe('platform-aware search', () => {
  it('ranks platform priority globs above alphabetical order', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-perfectpixel-platform-'));
    await mkdir(path.join(root, 'sections'), { recursive: true });
    await writeFile(path.join(root, 'aaa.liquid'), '.btn { color: red; }\n');
    await writeFile(path.join(root, 'sections', 'zzz.scss'), '.btn { color: red; }\n');
    // Without a platform, alphabetical order wins (aaa.liquid first).
    const plain = await searchSelectors(root, ['.btn']);
    expect(plain.get('.btn')![0]!.file).toBe('aaa.liquid');
    // With shopify, sections/ is a priority glob -> sections/zzz.scss first.
    const shopify = await searchSelectors(root, ['.btn'], undefined, undefined, 'shopify');
    expect(shopify.get('.btn')![0]!.file).toBe('sections/zzz.scss');
    // .liquid matches are classified as liquid-schema (a real source context).
    expect(shopify.get('.btn')!.find((m) => m.file === 'aaa.liquid')!.context).toBe(
      'liquid-schema',
    );
    await rm(root, { recursive: true, force: true });
  });

  it('auto-detects the platform from repo markers', async () => {
    const mk = async (files: Record<string, string>) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-perfectpixel-detect-'));
      for (const [rel, content] of Object.entries(files)) {
        await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
        await writeFile(path.join(root, rel), content);
      }
      return root;
    };
    const { detectPlatform } = await import('@mcp-perfectpixel/core');

    let root = await mk({ 'sections/header.liquid': 'x' });
    expect(await detectPlatform(root)).toBe('shopify');
    await rm(root, { recursive: true, force: true });

    root = await mk({ 'stencil.conf.json': '{}', 'templates/index.html': '<div></div>' });
    expect(await detectPlatform(root)).toBe('bigcommerce');
    await rm(root, { recursive: true, force: true });

    root = await mk({ 'package.json': '{"dependencies":{"vue":"^3"}}' });
    expect(await detectPlatform(root)).toBe('vue');
    await rm(root, { recursive: true, force: true });

    root = await mk({ 'tailwind.config.js': 'module.exports = {}' });
    expect(await detectPlatform(root)).toBe('html-tailwind');
    await rm(root, { recursive: true, force: true });

    root = await mk({ 'README.md': 'nothing here' });
    expect(await detectPlatform(root)).toBeUndefined();
    await rm(root, { recursive: true, force: true });
  });
});
