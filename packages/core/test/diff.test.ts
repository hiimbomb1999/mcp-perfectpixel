import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PNG } from 'pngjs';
import {
  diffImages,
  dropTextNoise,
  isTextLikeRegion,
  regionDiffersAt,
  resizeRgba,
  decodePng,
  decodeJpg,
  decodeImage,
} from '@mcp-perfectpixel/core';
import type { RgbaImage } from '@mcp-perfectpixel/core';
import { encode as encodeJpeg } from 'jpeg-js';

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

describe('diffImages', () => {
  it('returns zero diff and no regions for identical images', () => {
    const a = makeImage(100, 100, [255, 255, 255]);
    const b = makeImage(100, 100, [255, 255, 255]);
    const result = diffImages(a, b);
    expect(result.diffPixelCount).toBe(0);
    expect(result.diffRatio).toBe(0);
    expect(result.regions).toEqual([]);
  });

  it('groups connected differing pixels into one region per cluster', () => {
    const design = makeImage(100, 100, [255, 255, 255]);
    const page = makeImage(100, 100, [255, 255, 255]);
    paint(page, 20, 20, 10, 10, [255, 0, 0]); // strong red block
    paint(page, 70, 70, 5, 5, [255, 0, 0]); // second, distant block
    const result = diffImages(design, page);

    expect(result.diffPixelCount).toBe(100 + 25);
    expect(result.regions).toHaveLength(2);
    const byX = new Map(result.regions.map((r) => [r.x, r]));
    expect(byX.get(20)).toMatchObject({ y: 20, width: 10, height: 10, pixelCount: 100 });
    expect(byX.get(70)).toMatchObject({ y: 70, width: 5, height: 5, pixelCount: 25 });
  });

  it('merges nearby clusters into a single region', () => {
    const design = makeImage(100, 100, [255, 255, 255]);
    const page = makeImage(100, 100, [255, 255, 255]);
    paint(page, 20, 20, 4, 4, [255, 0, 0]);
    paint(page, 28, 20, 4, 4, [255, 0, 0]); // 4px gap -> merged (margin 12)
    const result = diffImages(design, page);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]).toMatchObject({ x: 20, y: 20, width: 12, height: 4, pixelCount: 32 });
  });

  it('merges exactly at the margin gap but not beyond it', () => {
    const make = (gap: number) => {
      const design = makeImage(100, 100, [255, 255, 255]);
      const page = makeImage(100, 100, [255, 255, 255]);
      paint(page, 20, 20, 4, 4, [255, 0, 0]);
      paint(page, 20 + 4 + gap, 20, 4, 4, [255, 0, 0]);
      return diffImages(design, page);
    };
    expect(make(12).regions).toHaveLength(1); // gap == margin -> merge
    expect(make(13).regions).toHaveLength(2); // gap > margin -> separate
  });

  it('scores a large solid color change as high severity', () => {
    const design = makeImage(100, 100, [255, 255, 255]);
    const page = makeImage(100, 100, [255, 255, 255]);
    paint(page, 20, 20, 10, 10, [255, 0, 0]);
    const result = diffImages(design, page);
    expect(result.regions).toHaveLength(1);
    const region = result.regions[0]!;
    expect(region.severity).toBe('high');
    expect(region.score).toBeGreaterThan(0.5);
    expect(region.meanDelta).toBeGreaterThan(0.4);
  });

  it('scores a subtle color change as medium severity', () => {
    const design = makeImage(100, 100, [255, 255, 255]);
    const page = makeImage(100, 100, [255, 255, 255]);
    paint(page, 20, 20, 4, 4, [200, 200, 200]); // clearly darker than white, still subtle
    const result = diffImages(design, page);
    expect(result.regions).toHaveLength(1);
    const region = result.regions[0]!;
    expect(region.severity).toBe('medium');
    expect(region.score).toBeGreaterThanOrEqual(0.2);
    expect(region.score).toBeLessThan(0.5);
  });

  it('scores sparse, subtle differences as low severity', () => {
    const design = makeImage(100, 100, [255, 255, 255]);
    const page = makeImage(100, 100, [255, 255, 255]);
    // A 9x9 area where only a 17-pixel plus differs -> low coverage, low delta.
    paint(page, 45, 41, 1, 9, [200, 200, 200]);
    paint(page, 41, 45, 9, 1, [200, 200, 200]);
    const result = diffImages(design, page);
    const region = result.regions[0]!;
    expect(region.severity).toBe('low');
    expect(region.score).toBeLessThan(0.2);
  });

  it('throws on dimension mismatch', () => {
    expect(() => diffImages(makeImage(10, 10, [0, 0, 0]), makeImage(11, 10, [0, 0, 0]))).toThrow(
      /Dimension mismatch/,
    );
  });
});

describe('resizeRgba', () => {
  it('is a no-op when dimensions already match', () => {
    const img = makeImage(8, 8, [1, 2, 3]);
    expect(resizeRgba(img, 8, 8)).toBe(img);
  });

  it('bilinearly resizes and preserves corner colors', () => {
    const img = makeImage(2, 1, [0, 0, 0]);
    paint(img, 0, 0, 1, 1, [255, 0, 0]); // left pixel red
    paint(img, 1, 0, 1, 1, [0, 0, 255]); // right pixel blue
    const out = resizeRgba(img, 4, 2);
    expect(out.width).toBe(4);
    expect(out.height).toBe(2);
    // Corners map exactly to input corners: (0,0), (3,0) and (3,1).
    expect([out.data[0], out.data[1], out.data[2]]).toEqual([255, 0, 0]);
    expect([out.data[12], out.data[13], out.data[14]]).toEqual([0, 0, 255]);
    expect([out.data[28], out.data[29], out.data[30]]).toEqual([0, 0, 255]);
  });
});

describe('decodePng / decodeJpg', () => {
  it('round-trips PNG', () => {
    const img = makeImage(4, 4, [12, 34, 56]);
    const png = new PNG({ width: 4, height: 4 });
    img.data.copy(png.data);
    const decoded = decodePng(PNG.sync.write(png));
    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(4);
    expect([decoded.data[0], decoded.data[1], decoded.data[2]]).toEqual([12, 34, 56]);
  });

  it('round-trips JPEG', () => {
    const img = makeImage(6, 6, [200, 100, 50]);
    const jpeg = encodeJpeg({ data: img.data, width: 6, height: 6 }, 90);
    const decoded = decodeJpg(Buffer.from(jpeg.data));
    expect(decoded.width).toBe(6);
    expect(decoded.height).toBe(6);
    // JPEG is lossy; the color must be close, not exact.
    expect(Math.abs(decoded.data[0] - 200)).toBeLessThanOrEqual(15);
    expect(Math.abs(decoded.data[1] - 100)).toBeLessThanOrEqual(15);
    expect(Math.abs(decoded.data[2] - 50)).toBeLessThanOrEqual(15);
  });

  it('decodes an image from an http(s) URL (Figma export link support)', async () => {
    const img = makeImage(4, 4, [10, 20, 30]);
    const png = new PNG({ width: 4, height: 4 });
    img.data.copy(png.data);
    const pngBuf = PNG.sync.write(png);
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'image/png');
      res.end(pngBuf);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const decoded = await decodeImage(`http://127.0.0.1:${port}/export.png`);
      expect(decoded.width).toBe(4);
      expect(decoded.height).toBe(4);
      expect([decoded.data[0], decoded.data[1], decoded.data[2]]).toEqual([10, 20, 30]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('reports a clear error for an unreachable design URL', async () => {
    await expect(decodeImage('http://127.0.0.1:1/nope.png')).rejects.toThrow(/Failed to fetch/);
  });
});

describe('isTextLikeRegion', () => {
  // Text glyphs (dark rects) on a light background — high luma variance.
  const TEXT_DESIGN = () => {
    const img = makeImage(100, 100, [255, 255, 255]);
    paint(img, 20, 20, 4, 10, [32, 32, 32]);
    paint(img, 26, 20, 4, 10, [32, 32, 32]);
    paint(img, 32, 20, 4, 10, [32, 32, 32]);
    return img;
  };
  const TEXT_REGION = { x: 20, y: 20, width: 16, height: 10 };

  it('returns true for dark glyphs on a light background', () => {
    expect(isTextLikeRegion(TEXT_DESIGN(), TEXT_REGION)).toBe(true);
  });

  it('returns false for a solid-color region', () => {
    const img = makeImage(100, 100, [37, 99, 235]); // solid blue button
    expect(isTextLikeRegion(img, { x: 0, y: 0, width: 100, height: 100 })).toBe(false);
  });

  it('returns false for an empty or fully transparent region', () => {
    const img = makeImage(100, 100, [255, 255, 255]);
    for (let i = 0; i < img.data.length; i += 4) img.data[i + 3] = 0;
    expect(isTextLikeRegion(img, { x: 0, y: 0, width: 10, height: 10 })).toBe(false);
  });
});

describe('regionDiffersAt', () => {
  it('reports true for a strong diff at any threshold', () => {
    const design = makeImage(100, 100, [255, 255, 255]);
    const shot = makeImage(100, 100, [255, 255, 255]);
    paint(shot, 20, 20, 10, 10, [255, 0, 0]);
    const region = { x: 20, y: 20, width: 10, height: 10 };
    expect(regionDiffersAt(design, shot, region, 0.1)).toBe(true);
    expect(regionDiffersAt(design, shot, region, 0.2)).toBe(true);
  });

  it('reports true at the default threshold but false at a more lenient one (AA-like)', () => {
    // #202020 vs #484848: 40 gray units — between 0.1 (diff) and 0.2 (no diff).
    const design = makeImage(100, 100, [255, 255, 255]);
    paint(design, 20, 20, 16, 10, [32, 32, 32]);
    const shot = makeImage(100, 100, [255, 255, 255]);
    paint(shot, 20, 20, 16, 10, [72, 72, 72]);
    const region = { x: 20, y: 20, width: 16, height: 10 };
    expect(regionDiffersAt(design, shot, region, 0.1)).toBe(true);
    expect(regionDiffersAt(design, shot, region, 0.2)).toBe(false);
  });
});

describe('dropTextNoise', () => {
  // Text-like design: dark glyphs on white; the screenshot renders them in a
  // slightly lighter gray (#484848) — a light AA-style difference.
  const textDesign = () => {
    const img = makeImage(100, 100, [255, 255, 255]);
    paint(img, 20, 20, 4, 10, [32, 32, 32]);
    paint(img, 26, 20, 4, 10, [32, 32, 32]);
    paint(img, 32, 20, 4, 10, [32, 32, 32]);
    return img;
  };
  const textShot = () => {
    const img = makeImage(100, 100, [255, 255, 255]);
    paint(img, 20, 20, 4, 10, [72, 72, 72]);
    paint(img, 26, 20, 4, 10, [72, 72, 72]);
    paint(img, 32, 20, 4, 10, [72, 72, 72]);
    return img;
  };
  const strongShot = () => {
    const img = makeImage(100, 100, [255, 255, 255]);
    paint(img, 20, 20, 16, 10, [220, 38, 38]); // real content diff, not AA
    return img;
  };
  const textRegion = {
    id: 1,
    x: 20,
    y: 20,
    width: 16,
    height: 10,
    pixelCount: 40,
    coverage: 0.25,
    areaRatio: 0.016,
    meanDelta: 0.18,
    maxDelta: 0.18,
    score: 0.3,
    severity: 'medium' as const,
    source: null,
  };

  it('drops a text-like region whose diff disappears under the lenient threshold', () => {
    const { regions, dropped } = dropTextNoise(textDesign(), textShot(), [textRegion], {
      textThreshold: 0.2,
    });
    expect(dropped).toBe(1);
    expect(regions).toEqual([]);
  });

  it('keeps a text-like region whose diff persists under the lenient threshold', () => {
    const { regions, dropped } = dropTextNoise(textDesign(), strongShot(), [textRegion], {
      textThreshold: 0.2,
    });
    expect(dropped).toBe(0);
    expect(regions).toEqual([textRegion]);
  });

  it('keeps a non-text region even when its diff is light', () => {
    // Solid light-gray block (low variance) with a light diff — not text.
    const design = makeImage(100, 100, [255, 255, 255]);
    paint(design, 20, 20, 16, 10, [220, 220, 220]);
    const shot = makeImage(100, 100, [255, 255, 255]);
    paint(shot, 20, 20, 16, 10, [255, 255, 255]);
    const { regions, dropped } = dropTextNoise(design, shot, [textRegion], {
      textThreshold: 0.2,
    });
    expect(dropped).toBe(0);
    expect(regions).toHaveLength(1);
  });

  it('honors an extra isText detector (e.g. a text-named Figma node)', () => {
    const design = makeImage(100, 100, [255, 255, 255]);
    paint(design, 20, 20, 16, 10, [220, 220, 220]);
    const shot = makeImage(100, 100, [255, 255, 255]);
    paint(shot, 20, 20, 16, 10, [255, 255, 255]);
    // Low-variance region, but the Figma node is named "Price" — treat as text.
    const { regions, dropped } = dropTextNoise(design, shot, [textRegion], {
      textThreshold: 0.2,
      isText: (r) => r.x === 20, // stands in for a name pattern match
    });
    expect(dropped).toBe(1);
    expect(regions).toEqual([]);
  });
});
