import { describe, expect, it } from 'vitest';
import {
  decodeMappings,
  decodeVLQ,
  extractSourceMappingUrl,
  mapOffset,
  offsetToLineCol,
  originalPositionFor,
  parseSourceMap,
} from '@mcp-perfectpixel/core';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 VLQ encoder (sign bit in LSB of the first group). */
function vlq(value: number): string {
  let v = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += B64[digit]!;
  } while (v > 0);
  return out;
}

function segment(genCol: number, src: number, line: number, col: number): string {
  return vlq(genCol) + vlq(src) + vlq(line) + vlq(col);
}

describe('decodeVLQ', () => {
  it('decodes positive and negative values', () => {
    for (const value of [0, 1, 15, 16, 100, 1000, -1, -100, 123456]) {
      const encoded = vlq(value);
      const [decoded, next] = decodeVLQ(encoded, 0);
      expect(decoded).toBe(value);
      expect(next).toBe(encoded.length);
    }
  });

  it('decodes multi-group values with continuation bits', () => {
    // 123456 << 1 = 246912; verify it round-trips through several groups.
    expect(decodeVLQ(vlq(123456), 0)[0]).toBe(123456);
  });
});

describe('decodeMappings + originalPositionFor', () => {
  it('maps generated positions back to original sources', () => {
    // Generated line 0: segment at col 0 -> source 0, orig line 2, col 5
    // Generated line 1: segment at col 0 -> source 0, orig line 4, col 1
    const mappings = `${segment(0, 0, 2, 5)};${segment(0, 0, 2, -4)}`;
    const lines = decodeMappings(mappings);

    expect(originalPositionFor(lines, 0, 0)).toEqual({ sourceIndex: 0, line: 2, column: 5 });
    expect(originalPositionFor(lines, 0, 40)).toEqual({ sourceIndex: 0, line: 2, column: 5 });
    expect(originalPositionFor(lines, 1, 0)).toEqual({ sourceIndex: 0, line: 4, column: 1 });
    // Line 2 has no segments -> falls back to the last segment of line 1.
    expect(originalPositionFor(lines, 2, 0)).toEqual({ sourceIndex: 0, line: 4, column: 1 });
  });

  it('handles source-less segments', () => {
    const lines = decodeMappings('AAAA;AACA');
    expect(originalPositionFor(lines, 0, 0)).toEqual({ sourceIndex: 0, line: 0, column: 0 });
    expect(originalPositionFor(lines, 1, 0)).toEqual({ sourceIndex: 0, line: 1, column: 0 });
  });
});

describe('offsetToLineCol + mapOffset', () => {
  const cssText = '.header {\n  background-color: #2563eb;\n}\n.button {\n  color: red;\n}';

  it('computes line/column from byte offsets', () => {
    expect(offsetToLineCol(cssText, 0)).toEqual({ line: 0, column: 0 });
    // ".header {": offset 8 is on line 0, column 8
    expect(offsetToLineCol(cssText, 8)).toEqual({ line: 0, column: 8 });
    // ".button" starts after three newlines
    const buttonOffset = cssText.indexOf('.button');
    expect(offsetToLineCol(cssText, buttonOffset)).toEqual({ line: 3, column: 0 });
  });

  it('maps a generated offset through a decoded map', () => {
    const mappings = `${segment(0, 0, 4, 2)};${segment(0, 0, 2, 0)}`;
    const lines = decodeMappings(mappings);
    const buttonOffset = cssText.indexOf('.button');
    const pos = mapOffset(lines, cssText, buttonOffset);
    expect(pos).toEqual({ sourceIndex: 0, line: 6, column: 2 });
  });
});

describe('extractSourceMappingUrl + parseSourceMap', () => {
  it('extracts the sourceMappingURL comment', () => {
    expect(extractSourceMappingUrl('a { color: red; }\n/*# sourceMappingURL=app.css.map */')).toBe(
      'app.css.map',
    );
    expect(extractSourceMappingUrl('a { color: red; }')).toBeNull();
  });

  it('parses a source map document', () => {
    const map = parseSourceMap(
      JSON.stringify({ version: 3, sources: ['a.scss'], names: [], mappings: 'AAAA' }),
    );
    expect(map.sources).toEqual(['a.scss']);
    expect(() => parseSourceMap('{"version":3}')).toThrow(/Invalid source map/);
  });
});
