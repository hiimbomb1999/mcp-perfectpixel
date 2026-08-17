import { describe, expect, it } from 'vitest';
import { pickElement, regionSamplePoints } from '@mcp-perfectpixel/core';

function el(overrides: Partial<{ x: number; y: number; width: number; height: number }> = {}) {
  return {
    tag: 'div',
    id: null,
    classes: ['x'],
    computed: {},
    rect: { x: 0, y: 0, width: 100, height: 100, ...overrides },
  };
}

const REGION = { x: 10, y: 10, width: 100, height: 100 };

describe('regionSamplePoints', () => {
  it('returns center + quarter points clamped to the region', () => {
    const pts = regionSamplePoints(REGION);
    expect(pts).toContainEqual({ x: 60, y: 60 }); // center
    expect(pts).toContainEqual({ x: 30, y: 30 }); // 0.2/0.2
    expect(pts).toContainEqual({ x: 90, y: 90 }); // 0.8/0.8
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(10);
      expect(p.y).toBeGreaterThanOrEqual(10);
      expect(p.x).toBeLessThanOrEqual(109);
      expect(p.y).toBeLessThanOrEqual(109);
    }
    expect(pts.length).toBeLessThanOrEqual(5);
  });

  it('dedupes points that collapse to the same pixel', () => {
    const pts = regionSamplePoints({ x: 0, y: 0, width: 1, height: 1 });
    expect(pts.length).toBe(1);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
  });
});

describe('pickElement', () => {
  const region = { x: 0, y: 0, width: 100, height: 100 };

  it('picks the element with the largest overlap with the region', () => {
    const big = el({ x: 0, y: 0, width: 100, height: 100 });
    const small = el({ x: 200, y: 200, width: 10, height: 10 });
    const picked = pickElement(region, [small, big]);
    expect(picked!.element).toBe(big);
    expect(picked!.pointIndex).toBe(1);
  });

  it('picks the smaller element on overlap ties', () => {
    // Both cover the whole region (equal overlap 100x100); b is smaller.
    const a = el({ x: 0, y: 0, width: 200, height: 200 });
    const b = el({ x: -50, y: -50, width: 150, height: 150 });
    const picked = pickElement(region, [a, b]);
    expect(picked!.element).toBe(b);
  });

  it('skips null points (empty center) and still finds an element', () => {
    const far = el({ x: 0, y: 0, width: 100, height: 100 });
    const picked = pickElement(region, [null, null, far, null]);
    expect(picked!.element).toBe(far);
  });

  it('returns null when every point is empty', () => {
    expect(pickElement(region, [null, null])).toBeNull();
  });
});
