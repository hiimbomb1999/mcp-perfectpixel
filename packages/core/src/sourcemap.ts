/**
 * Source Map v3 support — decode the `mappings` VLQ field and map a byte offset
 * in the *generated* CSS text back to an original source position. This is the
 * standard, build-tool-agnostic mechanism (Sass, Less, PostCSS, Tailwind,
 * Webpack and Vite all emit it), so tracing works regardless of what templating
 * language produced the HTML.
 */

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < BASE64_CHARS.length; i++) {
  BASE64_LOOKUP[BASE64_CHARS[i]!] = i;
}

export interface SourceMapV3 {
  version: number;
  sources: string[];
  sourcesContent?: Array<string | null>;
  names?: string[];
  mappings: string;
}

export interface Segment {
  genCol: number;
  srcIdx: number; // -1 when the segment carries no source info
  origLine: number;
  origCol: number;
}

export interface OriginalPosition {
  /** Index into the map's `sources` array. */
  sourceIndex: number;
  /** 0-based line. */
  line: number;
  /** 0-based column. */
  column: number;
}

/** Decode the base64 VLQ value starting at `start`; returns [value, nextIndex]. */
export function decodeVLQ(str: string, start: number): [number, number] {
  let result = 0;
  let shift = 0;
  let i = start;
  for (;;) {
    const digit = BASE64_LOOKUP[str[i]!];
    if (digit === undefined) {
      throw new Error(`Invalid base64 VLQ character at index ${i}`);
    }
    const continuation = digit & 32;
    result += (digit & 31) << shift;
    if (continuation === 0) break;
    shift += 5;
    i++;
  }
  const negate = result & 1;
  result >>>= 1;
  return [negate ? -result : result, i + 1];
}

/**
 * Decode the `mappings` string into per-generated-line segment lists.
 * Segments within a line are ordered by generated column.
 */
export function decodeMappings(mappings: string): Map<number, Segment[]> {
  const lines = new Map<number, Segment[]>();
  let genLine = 0;
  let genCol = 0;
  let srcIdx = 0;
  let origLine = 0;
  let origCol = 0;
  let current: Segment[] = [];
  const flush = () => {
    if (current.length > 0) {
      lines.set(genLine, current);
      current = [];
    }
  };
  let i = 0;
  while (i < mappings.length) {
    const ch = mappings[i];
    if (ch === ';') {
      flush();
      genLine++;
      genCol = 0;
      i++;
      continue;
    }
    if (ch === ',') {
      i++;
      continue;
    }
    const [colDelta, afterCol] = decodeVLQ(mappings, i);
    genCol += colDelta;
    // A segment may carry source info; the first field is always genCol.
    let next = afterCol;
    let seg: Segment;
    if (next < mappings.length && mappings[next] !== ',' && mappings[next] !== ';') {
      const [sDelta, afterSrc] = decodeVLQ(mappings, next);
      srcIdx += sDelta;
      const [lDelta, afterLine] = decodeVLQ(mappings, afterSrc);
      origLine += lDelta;
      const [cDelta, afterCol2] = decodeVLQ(mappings, afterLine);
      origCol += cDelta;
      seg = { genCol, srcIdx, origLine, origCol };
      next = afterCol2;
    } else {
      seg = { genCol, srcIdx: -1, origLine: 0, origCol: 0 };
    }
    current.push(seg);
    i = next;
  }
  flush();
  return lines;
}

/** Convert a byte offset in `cssText` to 0-based line/column. */
export function offsetToLineCol(cssText: string, offset: number): { line: number; column: number } {
  let line = 0;
  let lastNewline = -1;
  for (let i = 0; i < offset; i++) {
    if (cssText.charCodeAt(i) === 10) {
      line++;
      lastNewline = i;
    }
  }
  return { line, column: offset - lastNewline - 1 };
}

/**
 * Find the original position covering a generated (line, column): the last
 * segment on the same generated line at or before the column, else the last
 * segment of the nearest previous line.
 */
export function originalPositionFor(
  segmentsByLine: Map<number, Segment[]>,
  genLine: number,
  genCol: number,
): OriginalPosition | null {
  const segs = segmentsByLine.get(genLine);
  if (segs && segs.length > 0) {
    let lo = 0;
    let hi = segs.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid]!.genCol <= genCol) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best >= 0) {
      const s = segs[best]!;
      if (s.srcIdx >= 0) return { sourceIndex: s.srcIdx, line: s.origLine, column: s.origCol };
    }
  }
  for (let l = genLine - 1; l >= 0; l--) {
    const prev = segmentsByLine.get(l);
    if (prev && prev.length > 0) {
      const s = prev[prev.length - 1]!;
      if (s.srcIdx >= 0) return { sourceIndex: s.srcIdx, line: s.origLine, column: s.origCol };
    }
  }
  return null;
}

/** Map a generated-CSS byte offset to a source location, or null. */
export function mapOffset(
  segmentsByLine: Map<number, Segment[]>,
  cssText: string,
  offset: number,
): OriginalPosition | null {
  const { line, column } = offsetToLineCol(cssText, offset);
  return originalPositionFor(segmentsByLine, line, column);
}

/** Extract the sourceMappingURL target (the `sourceMappingURL=` comment) from CSS text. */
export function extractSourceMappingUrl(cssText: string): string | null {
  const match = cssText.match(/\/\*[#@]\s*sourceMappingURL=([^*\s]+)\s*\*\//);
  return match ? match[1]! : null;
}

/** Parse a source map document (JSON, possibly embedded in a data: URL). */
export function parseSourceMap(data: string): SourceMapV3 {
  const json = JSON.parse(data) as SourceMapV3;
  if (
    typeof json.version !== 'number' ||
    !Array.isArray(json.sources) ||
    typeof json.mappings !== 'string'
  ) {
    throw new Error('Invalid source map: expected { version, sources, mappings }');
  }
  return json;
}
