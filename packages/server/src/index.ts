#!/usr/bin/env node
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { captureAndDiff, captureAndDiffMultiViewport } from '@mcp-perfectpixel/core';

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
  context: z
    .enum(['source-css', 'source', 'test', 'docs', 'generated', 'liquid-schema', 'vue-sfc-style'])
    .optional(),
});
const ruleSchema = z.object({
  selector: z.string(),
  media: z.string().nullable(),
  supports: z.string().nullable(),
  container: z.string().nullable(),
  layer: z.string().nullable(),
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
      kind: z.enum(['css-variable', 'scss', 'tailwind', 'style-dictionary']),
    })
    .nullable(),
  figmaToken: z
    .object({ name: z.string(), value: z.string(), kind: z.string() })
    .nullable()
    .optional(),
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
  figmaNode: z.string().nullable().optional(),
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
      notes: z.array(z.string()),
      dimensionAnalysis: z
        .object({
          property: z.string(),
          computed: z.string(),
          designEstimate: z.string(),
          likelyCause: z.string(),
        })
        .optional(),
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
    responsive: z.object({ mediaQueries: z.number(), containerQueries: z.number() }).optional(),
  }),
  artifacts: z.object({
    screenshotPath: z.string(),
    diffImagePath: z.string(),
    designImagePath: z.string(),
    designImageSource: z.string(),
    designImageHash: z.string().optional(),
  }),
  trace: z.object({
    status: z.enum(['skipped', 'ok', 'partial', 'failed']),
    warnings: z.array(z.string()),
  }),
  repoRoot: z.string(),
  textNoiseFilter: z
    .object({
      enabled: z.boolean(),
      threshold: z.number().optional(),
      droppedRegions: z.array(
        z.object({
          id: z.number(),
          reason: z.string(),
        }),
      ),
    })
    .optional(),
  layoutAnalysis: z
    .object({
      spacing: z.object({
        issues: z.array(
          z.object({
            type: z.enum(['margin', 'padding', 'gap', 'alignment']),
            property: z.string(),
            expected: z.string(),
            actual: z.string(),
            delta: z.number(),
            element: z.string(),
            figmaNode: z.string().optional(),
            suggestion: z.string(),
          }),
        ),
      }),
      typography: z.object({
        issues: z.array(
          z.object({
            element: z.string(),
            property: z.enum([
              'font-family',
              'font-size',
              'font-weight',
              'line-height',
              'letter-spacing',
            ]),
            expected: z.string(),
            actual: z.string(),
            figmaToken: z.string().optional(),
            suggestion: z.string(),
          }),
        ),
        textRegions: z.array(
          z.object({
            id: z.number(),
            text: z.string(),
            computedStyles: z.record(z.string()),
            designStyles: z.record(z.string()),
          }),
        ),
      }),
    })
    .optional(),
  responsiveAnalysis: z
    .object({
      issues: z.array(
        z.object({
          viewport: z.object({ width: z.number(), height: z.number() }),
          type: z.enum(['overlap', 'overflow', 'misalignment', 'missing-element']),
          element: z.string(),
          description: z.string(),
          suggestion: z.string(),
        }),
      ),
      breakpointCoverage: z.object({
        totalBreakpoints: z.number(),
        passingBreakpoints: z.number(),
        failingBreakpoints: z.number(),
      }),
    })
    .optional(),
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
      'hardcoded values — never full component rewrites. Responsive caution: the design ' +
      'image is a single-viewport raster, so pixel width/height in the output is only ' +
      'valid at the capture viewport — treat it as evidence, never as fixed values to ' +
      'hardcode; region notes flag fixed dimensions when the page itself is responsive ' +
      '(media/container queries), and capture.responsive reports those counts.',
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
      viewports: z
        .array(
          z.object({
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          }),
        )
        .optional()
        .describe(
          'Multiple viewports to capture for responsive verification. When provided, captures are run sequentially at each viewport. Overrides viewport if both are given.',
        ),
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
      platform: z
        .enum(['shopify', 'bigcommerce', 'html-tailwind', 'react', 'vue', 'auto'])
        .optional()
        .describe(
          'Codebase type — narrows source search priority globs and token scanning (SCSS variables, ' +
            "Shopify theme schema JSON). Default 'auto': detected from repoRoot markers.",
        ),
      designContext: z
        .object({
          scale: z
            .number()
            .positive()
            .optional()
            .describe(
              'Export scale of the design image relative to the Figma frame (1, 2 or 3). If set, the ' +
                'viewport is derived by dividing the image dimensions by the scale instead of using raw pixels.',
            ),
          tokens: z
            .array(
              z.object({
                name: z.string(),
                value: z.string(),
                kind: z.enum(['color', 'spacing', 'radius', 'font']),
              }),
            )
            .optional()
            .describe(
              'Design tokens resolved from Figma variables/styles. Matched before repo-scanned tokens.',
            ),
          nodes: z
            .array(
              z.object({
                name: z.string(),
                x: z.number(),
                y: z.number(),
                width: z.number(),
                height: z.number(),
              }),
            )
            .optional()
            .describe('Figma node bounding boxes (design image space) for annotating regions.'),
        })
        .optional()
        .describe('Extra design context supplied by the caller, e.g. from the Figma MCP server.'),
      textRegionThreshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          'Extra pixelmatch threshold for text-like regions (high color variance). Regions whose diff ' +
            'disappears under this more lenient threshold are dropped as anti-aliasing noise.',
        ),
      analyzeLayout: z
        .boolean()
        .optional()
        .describe(
          'Enable advanced layout analysis (spacing, typography, alignment). When true, analyzes ' +
            'spacing issues, typography mismatches, and alignment problems. Default: false.',
        ),
      validateResponsive: z
        .boolean()
        .optional()
        .describe(
          'Enable responsive design validation across multiple viewports. When true with viewports array, ' +
            'analyzes layout at each breakpoint to detect overlaps, overflows, and misalignments. Default: false.',
        ),
    },
    outputSchema,
  },
  async (args) => {
    try {
      const options = {
        url: args.url,
        designImagePath: args.designImagePath,
        viewport: args.viewport,
        viewports: args.viewports,
        outputDir: args.outputDir,
        waitForSelector: args.waitForSelector,
        waitMs: args.waitMs,
        diffThreshold: args.diffThreshold,
        repoRoot: args.repoRoot,
        mode: args.mode,
        platform: args.platform,
        designContext: args.designContext,
        textRegionThreshold: args.textRegionThreshold,
        analyzeLayout: args.analyzeLayout,
        validateResponsive: args.validateResponsive,
      };

      // Use multi-viewport capture if viewports are provided.
      const result =
        args.viewports && args.viewports.length > 0
          ? await captureAndDiffMultiViewport(options)
          : await captureAndDiff(options);

      return {
        // Typed payload for clients that support structuredContent...
        structuredContent: { ...result } as Record<string, unknown>,
        // ...and human-readable text for everyone else.
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        structuredContent: {
          status: 'error',
          error: message,
          similarity: 0,
          diffPixelCount: 0,
          totalPixelCount: 0,
          diffRatio: 0,
          regions: [],
          capture: {
            url: args.url,
            viewport: { width: 0, height: 0 },
            viewportSource: 'provided',
            locale: '',
            timezoneId: '',
            reducedMotion: false,
            animationsDisabled: false,
            fontsWaited: false,
            durationMs: 0,
          },
          artifacts: {
            screenshotPath: '',
            diffImagePath: '',
            designImagePath: args.designImagePath,
            designImageSource: args.designImagePath,
          },
          trace: { status: 'failed', warnings: [message] },
          repoRoot: args.repoRoot ?? '',
        } as Record<string, unknown>,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ status: 'error', error: message }, null, 2),
          },
        ],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
