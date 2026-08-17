import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildPatches,
  findDesignTokens,
  normalizeColor,
  sampleDesignColor,
} from '@mcp-perfectpixel/core';
import type { DiffRegion, RgbaImage, RuleEvidence } from '@mcp-perfectpixel/core';

function makeImage(width: number, height: number, fill: [number, number, number]): RgbaImage {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

function paint(
  img: RgbaImage,
  x: number,
  y: number,
  w: number,
  h: number,
  color: [number, number, number],
): void {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const o = (py * img.width + px) * 4;
      img.data[o] = color[0];
      img.data[o + 1] = color[1];
      img.data[o + 2] = color[2];
      img.data[o + 3] = 255;
    }
  }
}

describe('sampleDesignColor', () => {
  it('returns the dominant opaque color of a region', () => {
    const img = makeImage(100, 100, [255, 255, 255]);
    paint(img, 20, 20, 10, 10, [22, 163, 74]); // #16a34a
    expect(sampleDesignColor(img, { x: 20, y: 20, width: 10, height: 10 })).toBe('#16a34a');
  });

  it('ignores anti-aliased edge pixels and transparency', () => {
    const img = makeImage(100, 100, [255, 255, 255]);
    paint(img, 20, 20, 10, 10, [0, 0, 255]);
    // Make one row transparent.
    for (let x = 20; x < 30; x++) img.data[(25 * 100 + x) * 4 + 3] = 0;
    expect(sampleDesignColor(img, { x: 20, y: 20, width: 10, height: 10 })).toBe('#0000ff');
  });

  it('returns null for an empty region', () => {
    const img = makeImage(10, 10, [0, 0, 0]);
    expect(sampleDesignColor(img, { x: 0, y: 0, width: 1, height: 1 })).toBeNull();
  });
});

describe('normalizeColor', () => {
  it('normalizes hex, rgb, rgba and hsl', () => {
    expect(normalizeColor('#abc')).toBe('#aabbcc');
    expect(normalizeColor('#AABBCC')).toBe('#aabbcc');
    expect(normalizeColor('#16a34a')).toBe('#16a34a');
    expect(normalizeColor('rgb(22, 163, 74)')).toBe('#16a34a');
    expect(normalizeColor('rgba(255, 0, 0, 1)')).toBe('#ff0000');
    expect(normalizeColor('hsl(0, 100%, 50%)')).toBe('#ff0000');
  });

  it('rejects unsupported values', () => {
    expect(normalizeColor('rgba(255, 0, 0, 0.5)')).toBeNull(); // translucent
    expect(normalizeColor('var(--color-success)')).toBeNull();
    expect(normalizeColor('linear-gradient(...)')).toBeNull();
    expect(normalizeColor('red')).toBeNull(); // named colors unsupported
    expect(normalizeColor('')).toBeNull();
  });
});

let tokenRoot: string;

beforeAll(async () => {
  tokenRoot = await mkdtemp(path.join(os.tmpdir(), 'mcp-perfectpixel-tokens-'));
  await writeFile(
    path.join(tokenRoot, 'styles.css'),
    ':root {\n  --color-success: #16a34a;\n  --brand: rgb(37, 99, 235);\n}\n',
  );
  await writeFile(
    path.join(tokenRoot, 'tailwind.config.js'),
    'module.exports = { theme: { colors: { primary: "#2563eb" } } };\n',
  );
  await writeFile(
    path.join(tokenRoot, 'tokens.json'),
    JSON.stringify({ color: { danger: { value: '#dc2626' } } }, null, 2),
  );
  await mkdir(path.join(tokenRoot, 'dist'), { recursive: true });
  await mkdir(path.join(tokenRoot, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(path.join(tokenRoot, 'dist', 'build.css'), ':root { --hidden: #ff0000; }\n');
  await writeFile(
    path.join(tokenRoot, 'node_modules', 'pkg', 'tokens.json'),
    '{"x":{"value":"#00ff00"}}\n',
  );
  await writeFile(path.join(tokenRoot, '.gitignore'), 'dist/\n');
});

afterAll(async () => {
  await rm(tokenRoot, { recursive: true, force: true });
});

describe('findDesignTokens', () => {
  it('finds CSS variables, Tailwind config colors and style-dictionary tokens', async () => {
    const tokens = await findDesignTokens(tokenRoot);
    const byName = new Map(tokens.map((t) => [t.name, t]));
    expect(byName.get('--color-success')).toMatchObject({
      reference: 'var(--color-success)',
      value: '#16a34a',
      kind: 'css-variable',
    });
    expect(byName.get('--brand')!.value).toBe('#2563eb');
    expect(byName.get('primary')).toMatchObject({ value: '#2563eb', kind: 'tailwind' });
    expect(byName.get('color.danger')).toMatchObject({
      value: '#dc2626',
      kind: 'style-dictionary',
    });
    // gitignored build output and node_modules are not scanned.
    expect(byName.has('--hidden')).toBe(false);
    expect(byName.has('x')).toBe(false);
  });
});

describe('buildPatches', () => {
  function rule(overrides: Partial<RuleEvidence>): RuleEvidence {
    return {
      selector: '.button',
      media: null,
      applies: true,
      properties: ['background-color'],
      declared: { 'background-color': '#dc2626' },
      source: { file: 'src/_page.scss', line: 5, column: 3, via: 'source-map', gitignored: false },
      confidence: 'high',
      ...overrides,
    };
  }

  it('suggests the design color as a token reference when a token matches', () => {
    const design = makeImage(100, 100, [255, 255, 255]);
    paint(design, 20, 20, 10, 10, [22, 163, 74]); // #16a34a
    const region = { x: 20, y: 20, width: 10, height: 10 } as DiffRegion;
    const tokens = [
      {
        name: '--color-success',
        reference: 'var(--color-success)',
        value: '#16a34a',
        file: 'styles.css',
        line: 2,
        kind: 'css-variable' as const,
      },
    ];
    const patches = buildPatches(design, region, [rule({})], tokens);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      file: 'src/_page.scss',
      line: 5,
      column: 3,
      property: 'background-color',
      current: '#dc2626',
      suggested: 'var(--color-success)',
      value: '#16a34a',
      confidence: 'high',
    });
    expect(patches[0]!.token!.kind).toBe('css-variable');
  });

  it('falls back to the raw hex when no token matches', () => {
    const design = makeImage(100, 100, [255, 255, 255]);
    paint(design, 20, 20, 10, 10, [22, 163, 74]);
    const patches = buildPatches(design, { x: 20, y: 20, width: 10, height: 10 }, [rule({})], []);
    expect(patches[0]!.suggested).toBe('#16a34a');
    expect(patches[0]!.token).toBeNull();
  });

  it('skips rules without an anchorable source', () => {
    const design = makeImage(100, 100, [255, 255, 255]);
    paint(design, 20, 20, 10, 10, [22, 163, 74]);
    const patches = buildPatches(
      design,
      { x: 20, y: 20, width: 10, height: 10 },
      [rule({ source: null })],
      [],
    );
    expect(patches).toEqual([]);
  });

  it('skips properties whose declared value already matches the design', () => {
    const design = makeImage(100, 100, [255, 255, 255]);
    paint(design, 20, 20, 10, 10, [220, 38, 38]); // #dc2626 = current
    const patches = buildPatches(design, { x: 20, y: 20, width: 10, height: 10 }, [rule({})], []);
    expect(patches).toEqual([]);
  });

  it('emits one patch per differing color property', () => {
    const design = makeImage(100, 100, [255, 255, 255]);
    paint(design, 20, 20, 10, 10, [22, 163, 74]);
    const patches = buildPatches(
      design,
      { x: 20, y: 20, width: 10, height: 10 },
      [
        rule({
          properties: ['background-color', 'border-color'],
          declared: { 'background-color': '#dc2626', 'border-color': '#111111' },
        }),
      ],
      [],
    );
    expect(patches.map((p) => p.property).sort()).toEqual(['background-color', 'border-color']);
  });
});
