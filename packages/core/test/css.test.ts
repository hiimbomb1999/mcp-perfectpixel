import { describe, expect, it } from 'vitest';
import { compareSpecificity, selectorKeyOf, specificityOf } from '@mcp-perfectpixel/core';

describe('specificityOf', () => {
  it('computes id/class/type counts', () => {
    expect(specificityOf('.a')).toEqual({ a: 0, b: 1, c: 0 });
    expect(specificityOf('#x')).toEqual({ a: 1, b: 0, c: 0 });
    expect(specificityOf('div')).toEqual({ a: 0, b: 0, c: 1 });
    expect(specificityOf('#x .a div:hover')).toEqual({ a: 1, b: 2, c: 1 });
    expect(specificityOf('*')).toEqual({ a: 0, b: 0, c: 0 });
    expect(specificityOf('button.btn[data-x]')).toEqual({ a: 0, b: 2, c: 1 });
  });

  it('treats :where() as zero and pseudo-elements as type selectors', () => {
    expect(specificityOf(':where(.a) .b')).toEqual({ a: 0, b: 1, c: 0 });
    expect(specificityOf('.a::before')).toEqual({ a: 0, b: 1, c: 1 });
  });

  it('takes the max across a selector list', () => {
    // `.a` is (0,1,0); `#x div` is (1,0,1) — the max wins.
    expect(specificityOf('.a, #x div')).toEqual({ a: 1, b: 0, c: 1 });
  });

  it('is robust against garbage', () => {
    expect(specificityOf('')).toEqual({ a: 0, b: 0, c: 0 });
    expect(specificityOf('!!!not a selector')).toEqual({ a: 0, b: 0, c: 0 });
  });

  it('orders comparisons correctly', () => {
    expect(compareSpecificity({ a: 1, b: 0, c: 0 }, { a: 0, b: 99, c: 99 })).toBeGreaterThan(0);
    expect(compareSpecificity({ a: 0, b: 2, c: 0 }, { a: 0, b: 1, c: 0 })).toBeGreaterThan(0);
    expect(compareSpecificity({ a: 0, b: 1, c: 2 }, { a: 0, b: 1, c: 3 })).toBeLessThan(0);
  });
});

describe('selectorKeyOf', () => {
  it('extracts the last compound tag/class/id', () => {
    expect(selectorKeyOf('.a .b')).toEqual({ tags: [], classes: ['b'], ids: [] });
    expect(selectorKeyOf('#x > div.c')).toEqual({ tags: ['div'], classes: ['c'], ids: [] });
    expect(selectorKeyOf('button.btn:hover')).toEqual({
      tags: ['button'],
      classes: ['btn'],
      ids: [],
    });
    expect(selectorKeyOf('.a, .b')).toEqual({ tags: [], classes: ['a', 'b'], ids: [] });
    expect(selectorKeyOf('ul li a')).toEqual({ tags: ['a'], classes: [], ids: [] });
  });

  it('is robust against garbage', () => {
    expect(selectorKeyOf('!!!bad')).toEqual({ tags: [], classes: [], ids: [] });
  });
});
