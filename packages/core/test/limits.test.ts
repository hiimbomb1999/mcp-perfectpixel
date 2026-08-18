import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { assertViewportOk, captureAndDiff, decodeImage, deriveViewport, MAX_WAIT_MS } from '@mcp-perfectpixel/core';

function pngBuffer(): Buffer {
  const png = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < 16; i++) {
    png.data[i * 4] = 10;
    png.data[i * 4 + 1] = 20;
    png.data[i * 4 + 2] = 30;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-perfectpixel-limits-'));
  await writeFile(path.join(dir, 'design.png'), pngBuffer());
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('assertViewportOk', () => {
  it('accepts normal viewports', () => {
    expect(() => assertViewportOk(1280, 800)).not.toThrow();
    expect(() => assertViewportOk(4096, 4096)).not.toThrow(); // exactly MAX_VIEWPORT_PIXELS
  });

  it('rejects oversized viewports', () => {
    expect(() => assertViewportOk(100_000, 100_000)).toThrow(/maximum side/);
    expect(() => assertViewportOk(5000, 5000)).toThrow(/maximum of/); // 25M pixels
    expect(() => assertViewportOk(0, 10)).toThrow(/Invalid/);
  });
});

describe('deriveViewport (designContext.scale)', () => {
  it('divides design dimensions by the export scale', () => {
    expect(deriveViewport(2400, 1600, undefined, 2)).toEqual({ width: 1200, height: 800 });
    expect(deriveViewport(3600, 2400, undefined, 3)).toEqual({ width: 1200, height: 800 });
  });

  it('keeps raw dimensions when no scale is given (backward compatible)', () => {
    expect(deriveViewport(800, 600, undefined, undefined)).toEqual({ width: 800, height: 600 });
  });

  it('lets an explicit viewport win over scale', () => {
    expect(deriveViewport(2400, 1600, { width: 375, height: 667 }, 2)).toEqual({
      width: 375,
      height: 667,
    });
  });
});

describe('captureAndDiff limits', () => {
  it('rejects an oversized viewport before launching a browser', async () => {
    await expect(
      captureAndDiff({
        url: 'https://example.com',
        designImagePath: path.join(dir, 'design.png'),
        viewport: { width: 10_000, height: 10_000 },
      }),
    ).rejects.toThrow(/maximum side/);
  });

  it('rejects an excessive waitMs', async () => {
    await expect(
      captureAndDiff({
        url: 'https://example.com',
        designImagePath: path.join(dir, 'design.png'),
        waitMs: MAX_WAIT_MS + 1,
      }),
    ).rejects.toThrow(/waitMs/);
  });

  it('hosted mode blocks private-network URLs, file:// and local paths', async () => {
    const design = path.join(dir, 'design.png');
    await expect(
      captureAndDiff({
        url: 'http://127.0.0.1:3000',
        designImagePath: design,
        mode: 'hosted',
        repoRoot: dir,
      }),
    ).rejects.toThrow(/private-network/);
    await expect(
      captureAndDiff({
        url: 'https://example.com',
        designImagePath: 'file:///etc/passwd',
        mode: 'hosted',
        repoRoot: dir,
      }),
    ).rejects.toThrow(/file:\/\//);
    await expect(
      captureAndDiff({
        url: 'https://example.com',
        designImagePath: '/etc/passwd',
        mode: 'hosted',
        repoRoot: dir,
      }),
    ).rejects.toThrow(/local filesystem/);
  });

  it('hosted mode requires an explicit repoRoot', async () => {
    await expect(
      captureAndDiff({
        url: 'https://example.com',
        designImagePath: path.join(dir, 'design.png'),
        mode: 'hosted',
      }),
    ).rejects.toThrow(/repoRoot/);
  });

  it('local mode still allows file:// and localhost', async () => {
    // Validation must pass; the failure (if any) is a network/browser error,
    // not a trust-boundary rejection.
    await expect(
      captureAndDiff({ url: 'file:///tmp/x.html', designImagePath: path.join(dir, 'design.png') }),
    ).rejects.not.toThrow(/private-network|file:\/\/ only|local filesystem/);
  });
});

describe('decodeImage limits', () => {
  it('rejects a local design file larger than 50MB', async () => {
    const big = path.join(dir, 'big.png');
    await writeFile(big, Buffer.alloc(51 * 1024 * 1024));
    await expect(decodeImage(big)).rejects.toThrow(/too large/);
  });

  it('times out on a hung remote server', async () => {
    const server = createServer(() => {
      // Never respond.
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(decodeImage(`http://127.0.0.1:${port}/x.png`, 'local', 200)).rejects.toThrow(
        /Failed to fetch/,
      );
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('follows redirects', async () => {
    const png = pngBuffer();
    const server = createServer((req, res) => {
      if (req.url === '/start.png') {
        res.statusCode = 302;
        res.setHeader('location', '/real.png');
        res.end();
        return;
      }
      res.setHeader('content-type', 'image/png');
      res.end(png);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const decoded = await decodeImage(`http://127.0.0.1:${port}/start.png`);
      expect(decoded.width).toBe(4);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
