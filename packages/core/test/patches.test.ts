import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildPatches,
  findCulpritProp,
  findDesignTokens,
  inheritanceNotes,
  normalizeColor,
  sampleDesignColor,
  type PatchRuleInput,
} from '@mcp-perfectpixel/core';
import type { RgbaImage } from '@mcp-perfectpixel/core';

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

  it('scans SCSS variables ($var) as design tokens', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-perfectpixel-scss-'));
    await mkdir(path.join(root, 'assets'), { recursive: true });
    await writeFile(
      path.join(root, 'assets', '_colors.scss'),
      '$primary-color: #16a34a;\n$danger: rgb(220, 38, 38);\n$spacing: 16px;\n',
    );
    await writeFile(path.join(root, 'styles.scss'), '$brand: #2563eb;\n');
    const tokens = await findDesignTokens(root, undefined, 'bigcommerce');
    const byName = new Map(tokens.map((t) => [t.name, t]));
    expect(byName.get('primary-color')).toMatchObject({
      reference: '$primary-color',
      value: '#16a34a',
      kind: 'scss',
    });
    expect(byName.get('danger')!.value).toBe('#dc2626');
    expect(byName.get('brand')).toBeDefined(); // .scss always scanned
    expect(byName.get('spacing')).toBeUndefined(); // non-color skipped
    await rm(root, { recursive: true, force: true });
  });

  it('extracts Shopify theme schema settings as tokens', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-perfectpixel-schema-'));
    await mkdir(path.join(root, 'sections'), { recursive: true });
    await writeFile(
      path.join(root, 'sections', 'header.liquid'),
      '{%- schema -%}\n{"settings": [\n  {"type": "color", "id": "color_primary", "default": "#2563eb"},\n  {"type": "color", "id": "color_bg", "default": "rgb(255, 255, 255)"},\n  {"type": "text", "id": "title", "default": "Hello"}\n]}\n{%- endschema -%}\n',
    );
    const tokens = await findDesignTokens(root, undefined, 'shopify');
    const byName = new Map(tokens.map((t) => [t.name, t]));
    expect(byName.get('settings:color_primary')).toMatchObject({
      reference: 'settings.color_primary',
      value: '#2563eb',
    });
    expect(byName.get('settings:color_bg')!.value).toBe('#ffffff');
    expect(byName.get('settings:title')).toBeUndefined(); // text setting skipped
    await rm(root, { recursive: true, force: true });
  });
});

describe('buildPatches', () => {
  const SOURCE = {
    file: 'src/_page.scss',
    line: 5,
    column: 3,
    via: 'source-map' as const,
    gitignored: false,
  };

  function rule(overrides: Partial<PatchRuleInput>): PatchRuleInput {
    return {
      selector: '.button',
      specificity: { a: 0, b: 1, c: 0 },
      sheetId: 0,
      index: 0,
      important: new Set<string>(),
      properties: ['background-color'],
      declared: { 'background-color': '#dc2626' },
      source: SOURCE,
      confidence: 'high',
      ...overrides,
    };
  }

  const GREEN_DESIGN = () => {
    const design = makeImage(100, 100, [255, 255, 255]);
    paint(design, 20, 20, 10, 10, [22, 163, 74]); // #16a34a
    return design;
  };
  const REGION = { x: 20, y: 20, width: 10, height: 10 };
  const COMPUTED_DIFFERS = { 'background-color': 'rgb(220, 38, 38)' };

  it('suggests the design color as a token reference when a token matches', () => {
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
    const patches = buildPatches(GREEN_DESIGN(), REGION, [rule({})], COMPUTED_DIFFERS, tokens);
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
    const patches = buildPatches(GREEN_DESIGN(), REGION, [rule({})], COMPUTED_DIFFERS, []);
    expect(patches[0]!.suggested).toBe('#16a34a');
    expect(patches[0]!.token).toBeNull();
  });

  it('prefers a Figma token (designContext.tokens) as ground truth', () => {
    const figmaTokens = [
      { name: 'Success/500', value: '#16a34a', kind: 'color' as const },
      { name: 'Success/700', value: '#15803d', kind: 'color' as const },
    ];
    const patches = buildPatches(
      GREEN_DESIGN(),
      REGION,
      [rule({})],
      COMPUTED_DIFFERS,
      [],
      figmaTokens,
    );
    expect(patches).toHaveLength(1);
    expect(patches[0]!.suggested).toBe('Success/500');
    expect(patches[0]!.figmaToken).toEqual({
      name: 'Success/500',
      value: '#16a34a',
      kind: 'color',
    });
    expect(patches[0]!.token).toBeNull(); // no repo token passed
  });

  it('reports both the Figma token and the matching repo token', () => {
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
    const figmaTokens = [{ name: 'Success/500', value: '#16a34a', kind: 'color' as const }];
    const patches = buildPatches(
      GREEN_DESIGN(),
      REGION,
      [rule({})],
      COMPUTED_DIFFERS,
      tokens,
      figmaTokens,
    );
    expect(patches).toHaveLength(1);
    // Figma name wins the suggestion; the repo token is still reported.
    expect(patches[0]!.suggested).toBe('Success/500');
    expect(patches[0]!.figmaToken!.name).toBe('Success/500');
    expect(patches[0]!.token!.reference).toBe('var(--color-success)');
  });

  it('skips rules without an anchorable source', () => {
    const patches = buildPatches(
      GREEN_DESIGN(),
      REGION,
      [rule({ source: null })],
      COMPUTED_DIFFERS,
      [],
    );
    expect(patches).toEqual([]);
  });

  it('skips when the current value already matches the design', () => {
    const design = makeImage(100, 100, [255, 255, 255]);
    paint(design, 20, 20, 10, 10, [220, 38, 38]); // #dc2626 = current
    const patches = buildPatches(design, REGION, [rule({})], COMPUTED_DIFFERS, []);
    expect(patches).toEqual([]);
  });

  it('emits ONE patch — the most likely culprit — never patch every color prop', () => {
    // Both background-color AND color differ in the computed style, but only
    // background-color may be patched (preference order), and only once.
    const patches = buildPatches(
      GREEN_DESIGN(),
      REGION,
      [
        rule({
          properties: ['background-color', 'color'],
          declared: { 'background-color': '#dc2626', color: '#111111' },
        }),
      ],
      { 'background-color': 'rgb(220, 38, 38)', color: 'rgb(17, 17, 17)' },
      [],
    );
    expect(patches).toHaveLength(1);
    expect(patches[0]!.property).toBe('background-color');
  });

  it('picks the cascade winner: higher specificity wins', () => {
    const base = rule({ index: 0 });
    const moreSpecific = rule({
      selector: '.button.primary',
      specificity: { a: 0, b: 2, c: 0 },
      index: 1,
      source: { ...SOURCE, line: 9 },
    });
    const patches = buildPatches(
      GREEN_DESIGN(),
      REGION,
      [base, moreSpecific],
      COMPUTED_DIFFERS,
      [],
    );
    expect(patches).toHaveLength(1);
    expect(patches[0]!.line).toBe(9); // winner is .button.primary
  });

  it('picks the cascade winner: !important beats specificity', () => {
    const important = rule({
      specificity: { a: 0, b: 1, c: 0 },
      index: 1,
      important: new Set(['background-color']),
      source: { ...SOURCE, line: 7 },
    });
    const moreSpecific = rule({
      selector: '.button.primary',
      specificity: { a: 0, b: 2, c: 0 },
      index: 0,
      source: { ...SOURCE, line: 9 },
    });
    const patches = buildPatches(
      GREEN_DESIGN(),
      REGION,
      [important, moreSpecific],
      COMPUTED_DIFFERS,
      [],
    );
    expect(patches[0]!.line).toBe(7); // !important wins
  });

  it('picks the cascade winner: same specificity -> later declaration wins', () => {
    const first = rule({ index: 0, source: { ...SOURCE, line: 4 } });
    const second = rule({ index: 2, source: { ...SOURCE, line: 6 } });
    const patches = buildPatches(GREEN_DESIGN(), REGION, [first, second], COMPUTED_DIFFERS, []);
    expect(patches[0]!.line).toBe(6); // later rule wins
  });

  it('handles shorthand declarations (background covers background-color)', () => {
    const patches = buildPatches(
      GREEN_DESIGN(),
      REGION,
      [rule({ properties: ['background'], declared: { background: '#dc2626' } })],
      COMPUTED_DIFFERS,
      [],
    );
    expect(patches).toHaveLength(1);
    expect(patches[0]!.property).toBe('background');
    expect(patches[0]!.current).toBe('#dc2626');
  });

  it('emits nothing when the diff is not color-related', () => {
    // Computed colors all match the design; no declared color prop differs.
    const design = GREEN_DESIGN();
    const patches = buildPatches(
      design,
      REGION,
      [rule({})],
      { 'background-color': 'rgb(22, 163, 74)' },
      [],
    );
    expect(patches).toEqual([]);
  });
});

describe('findCulpritProp + inheritanceNotes', () => {
  const GREEN_DESIGN = () => {
    const design = makeImage(100, 100, [255, 255, 255]);
    paint(design, 20, 20, 10, 10, [22, 163, 74]); // #16a34a
    return design;
  };
  const REGION = { x: 20, y: 20, width: 10, height: 10 };

  it('picks background-color before color when both differ', () => {
    const culprit = findCulpritProp(
      '#16a34a',
      { 'background-color': 'rgb(220, 38, 38)', color: 'rgb(17, 17, 17)' },
      [],
    );
    expect(culprit).toBe('background-color');
  });

  it('returns null when every parseable computed color matches the design', () => {
    expect(findCulpritProp('#16a34a', { 'background-color': 'rgb(22, 163, 74)' }, [])).toBeNull();
  });

  it('notes an inherited color with parent evidence', () => {
    const notes = inheritanceNotes(
      GREEN_DESIGN(),
      REGION,
      { color: 'rgb(220, 38, 38)' }, // red text on the element
      { color: 'rgb(0, 0, 0)' }, // black on the parent — inherited, not declared
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/inherited/);
    expect(notes[0]).toContain('rgb(220, 38, 38)');
  });

  it('produces no note when the inherited color already matches the design', () => {
    const notes = inheritanceNotes(
      GREEN_DESIGN(),
      REGION,
      { color: 'rgb(22, 163, 74)' },
      { color: 'rgb(22, 163, 74)' },
    );
    expect(notes).toEqual([]);
  });
});
