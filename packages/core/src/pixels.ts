import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { decode as decodeJpeg } from 'jpeg-js';
import type { RgbaImage } from './types.js';

/** Decode a PNG or JPG/JPEG file into an RGBA raster. */
export async function decodeImage(filePath: string): Promise<RgbaImage> {
  const buffer = await readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return decodePng(buffer);
  if (ext === '.jpg' || ext === '.jpeg') return decodeJpg(buffer);
  throw new Error(
    `Unsupported image format "${ext}" for ${filePath} — expected .png, .jpg or .jpeg`,
  );
}

export function decodePng(buffer: Buffer): RgbaImage {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: png.data };
}

export function decodeJpg(buffer: Buffer): RgbaImage {
  const jpeg = decodeJpeg(buffer, { useTArray: false, formatAsRGBA: true });
  return { width: jpeg.width, height: jpeg.height, data: Buffer.from(jpeg.data) };
}

/** Bilinear resize of an RGBA raster. Returns the input unchanged if dims match. */
export function resizeRgba(src: RgbaImage, width: number, height: number): RgbaImage {
  if (src.width === width && src.height === height) return src;
  const out = Buffer.alloc(width * height * 4);
  const { data, width: sw, height: sh } = src;
  const lastX = sw - 1;
  const lastY = sh - 1;
  for (let y = 0; y < height; y++) {
    const gy = height === 1 ? 0 : (y * lastY) / (height - 1);
    const y0 = Math.min(Math.floor(gy), lastY);
    const y1 = Math.min(y0 + 1, lastY);
    const fy = gy - y0;
    for (let x = 0; x < width; x++) {
      const gx = width === 1 ? 0 : (x * lastX) / (width - 1);
      const x0 = Math.min(Math.floor(gx), lastX);
      const x1 = Math.min(x0 + 1, lastX);
      const fx = gx - x0;
      const o00 = (y0 * sw + x0) * 4;
      const o01 = (y0 * sw + x1) * 4;
      const o10 = (y1 * sw + x0) * 4;
      const o11 = (y1 * sw + x1) * 4;
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) {
        const v =
          (1 - fx) * (1 - fy) * data[o00 + c]! +
          fx * (1 - fy) * data[o01 + c]! +
          (1 - fx) * fy * data[o10 + c]! +
          fx * fy * data[o11 + c]!;
        out[o + c] = Math.round(v);
      }
    }
  }
  return { width, height, data: out };
}

/**
 * Perceptual color delta between two pixels, normalized roughly to 0-1.
 * Uses the same YIQ-weighted euclidean metric as pixelmatch.
 */
export function colorDelta(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number {
  const r = r1 - r2;
  const g = g1 - g2;
  const b = b1 - b2;
  const y = 0.29889531 * r + 0.58662247 * g + 0.11448223 * b;
  const i = 0.59597799 * r - 0.2741761 * g - 0.32180189 * b;
  const q = 0.21147017 * r - 0.52261711 * g + 0.31114694 * b;
  return Math.sqrt(y * y + 0.48 * i * i + 0.48 * q * q) / 255;
}
