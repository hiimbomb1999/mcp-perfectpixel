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

const confidenceSchema = z.enum(['high', 'medium', 'low']);

// Output schema — clients receive `structuredContent` (typed JSON) instead of
// having to parse the text payload.
const sourceLocationSchema = z.object({
  file: z.string(),
  line: z.number(),
  column: z.number(),
  via: z.enum(['source-map', 'text-search']),
  gitignored: z.boolean(),
  context: z.enum(['source-css', 'source', 'test', 'docs', 'generated']).optional(),
});
const ruleSchema = z.object({
  selector: z.string(),
  media: z.string().nullable(),
  supports: z.string().nullable(),
  container: z.string().nullable(),
  applies: z.enum(['yes', 'no', 'unknown']),
  properties: z.array(z.string()),
  declared: z.record(z.string()),
  source: sourceLocationSchema.nullable(),
  confidence: confidenceSchema,
});
const patchSchema = z.object({
  file: z.string(),
  line: z.number(),
  column: z.number(),
  property: z.string(),
  current: z.string(),
  suggested: z.string(),
  value: z.string(),
  token: z
    .object({
      name: z.string(),
      reference: z.string(),
      value: z.string(),
      file: z.string(),
      line: z.number(),
      kind: z.enum(['css-variable', 'tailwind', 'style-dictionary']),
    })
    .nullable(),
  confidence: confidenceSchema,
});
const regionSchema = z.object({
  id: z.number(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  pixelCount: z.number(),
  coverage: z.number(),
  areaRatio: z.number(),
  meanDelta: z.number(),
  maxDelta: z.number(),
  score: z.number(),
  severity: z.enum(['high', 'medium', 'low']),
  source: z
    .object({
      element: z.object({
        tag: z.string(),
        id: z.string().nullable(),
        classes: z.array(z.string()),
        selector: z.string(),
        computedStyle: z.record(z.string()),
      }),
      rules: z.array(ruleSchema),
      confidence: confidenceSchema,
      patches: z.array(patchSchema),
    })
    .nullable(),
});
const outputSchema = {
  status: z.enum(['match', 'diff']),
  similarity: z.number(),
  diffPixelCount: z.number(),
  totalPixelCount: z.number(),
  diffRatio: z.number(),
  regions: z.array(regionSchema),
  capture: z.object({
    url: z.string(),
    viewport: z.object({ width: z.number(), height: z.number() }),
    viewportSource: z.enum(['design', 'provided']),
    locale: z.string(),
    timezoneId: z.string(),
    reducedMotion: z.boolean(),
    animationsDisabled: z.boolean(),
    fontsWaited: z.boolean(),
    durationMs: z.number(),
  }),
  artifacts: z.object({
    screenshotPath: z.string(),
    diffImagePath: z.string(),
    designImagePath: z.string(),
    designImageSource: z.string(),
  }),
  trace: z.object({
    status: z.enum(['skipped', 'ok', 'partial', 'failed']),
    warnings: z.array(z.string()),
  }),
  repoRoot: z.string(),
};

server.registerTool(
  'capture_and_diff',
  {
    description:
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
    inputSchema: {
      url: urlSchema.describe('Live URL to screenshot — http(s) or file URL.'),
      designImagePath: z
        .string()
        .describe(
          'Path to the static design image (PNG or JPG), or an http(s) image URL ' +
            '(e.g. a Figma export link). Absolute or relative to the server cwd.',
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
      mode: z
        .enum(['local', 'hosted'])
        .optional()
        .describe(
          "Trust boundary. 'local' (default) allows file:// URLs and local paths. 'hosted' blocks " +
            'file://, local paths and private-network hosts (SSRF protection) and requires an explicit repoRoot.',
        ),
    },
    outputSchema,
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
        mode: args.mode,
      });
      return {
        // Typed payload for clients that support structuredContent...
        structuredContent: { ...result } as Record<string, unknown>,
        // ...and human-readable text for everyone else.
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
