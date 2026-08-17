#!/usr/bin/env node
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { captureAndDiff } from '@mcp-perfectpixel/core';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const server = new McpServer({
  name: 'mcp-perfectpixel',
  version,
});

const urlSchema = z.string().refine((value) => /^(https?|file):\/\//.test(value), {
  message: 'url must be an absolute http(s) or file URL',
});

server.tool(
  'capture_and_diff',
  'Screenshot a live URL and diff it against a static design image (PNG/JPG). ' +
    'Capture is deterministic: animations disabled, fonts fully loaded, fixed locale (en-US) ' +
    'and timezone (UTC). Returns grouped diff regions (not raw pixel noise) with severity ' +
    'scores and bounding boxes, plus the overall similarity. The screenshot and a highlighted ' +
    'diff image are written to outputDir (default: a fresh temp dir). ' +
    'Use the returned regions as structured evidence for a design-to-code fix — the calling ' +
    'agent owns mapping regions to source code. Each region is also traced to its ' +
    'DOM element and real source location: CSS source maps first, then a ' +
    'gitignore-aware text search of repoRoot (medium confidence; matches in ' +
    'gitignored files are flagged as build output), or plain DOM/computed-style ' +
    'evidence with low confidence when nothing resolves. Each region also carries ' +
    'minimal patch suggestions (file, line, property, current -> suggested) derived ' +
    'from the design image pixels, preferring design tokens the project already ' +
    'defines (CSS custom properties, Tailwind config, style-dictionary) over new ' +
    'hardcoded values — never full component rewrites.',
  {
    url: urlSchema.describe('Live URL to screenshot — http(s) or file URL.'),
    designImagePath: z
      .string()
      .describe(
        'Path to the static design image (PNG or JPG), absolute or relative to the server cwd.',
      ),
    viewport: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .optional()
      .describe('Viewport in CSS pixels. Defaults to the design image dimensions.'),
    outputDir: z
      .string()
      .optional()
      .describe(
        'Directory to write the screenshot and diff artifacts into. Defaults to a fresh temp dir.',
      ),
    waitForSelector: z
      .string()
      .optional()
      .describe('CSS selector to wait for before screenshotting.'),
    waitMs: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Extra settle time after the page loads, in ms.'),
    diffThreshold: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('pixelmatch threshold — smaller is more sensitive. Default 0.1.'),
    repoRoot: z
      .string()
      .optional()
      .describe(
        'Root of the codebase to search for source locations (gitignore-aware text search). ' +
          'Defaults to the server working directory. CSS source maps resolve independently of this.',
      ),
  },
  async (args) => {
    try {
      const result = await captureAndDiff({
        url: args.url,
        designImagePath: args.designImagePath,
        viewport: args.viewport,
        outputDir: args.outputDir,
        waitForSelector: args.waitForSelector,
        waitMs: args.waitMs,
        diffThreshold: args.diffThreshold,
        repoRoot: args.repoRoot,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                status: 'error',
                error: error instanceof Error ? error.message : String(error),
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
