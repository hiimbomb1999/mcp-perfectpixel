# mcp-perfectpixel

**Codebase-grounded design-to-code diff server for the Model Context Protocol.**

`mcp-perfectpixel` is an MCP server that screenshots a live URL and diffs it against
a static design image (PNG/JPG), returning **grouped diff regions with severity
scores** — not raw pixel noise. Capture is **deterministic** (animations disabled,
fonts fully loaded, fixed locale/timezone), so re-runs are stable enough to reason
about pixel-by-pixel.

The server deliberately stops at supplying accurate, structured evidence: DOM-scale
bounding boxes, color deltas, severity, and the artifacts themselves. Mapping those
regions to real source files is left to the calling agent (Claude Code, Cursor,
DeepSeek Agent), which already reads the full repo and understands its own
conventions — this is what makes the tool work on any language or framework
without per-framework parsers.

> **Status:** Goals 1–3 are implemented and tested: deterministic capture +
> pixel diff with grouped severity-scored regions, tracing each region to its
> DOM element + real source location (CSS source maps, then gitignore-aware
> text search, with confidence scoring), and minimal patch suggestions that
> prefer the project's own design tokens — see [Roadmap](#roadmap).

## Features

- **Deterministic capture** — screenshots a URL in headless Chromium with
  animations/transitions disabled, `prefers-reduced-motion` forced, all web fonts
  awaited (`document.fonts.ready`), fixed `en-US` locale and UTC timezone, light
  color scheme, `deviceScaleFactor: 1`.
- **Grouped diff regions** — differing pixels are connected into clusters and
  nearby clusters merged, so you get "the button is wrong", not 4,000 scattered
  pixels. Each region carries a bounding box, pixel count, mean/max color delta,
  and a composite **severity score** (`high` / `medium` / `low`).
- **Region → source tracing** — every region is resolved to its DOM element
  (tag/id/classes, computed style) and the CSS rules styling it, each with a
  best-effort original source location and a **confidence score** (`high` /
  `medium` / `low`) — see [Source tracing](#source-tracing).
- **Overall similarity** — `1 - diffRatio` plus a `match` / `diff` status with a
  configurable tolerance.
- **Artifacts on disk** — the screenshot and a highlighted diff image (PNG) are
  written to an output directory and their paths returned, so the calling agent
  can inspect them directly.
- **PNG and JPG designs** — the design image is decoded natively; if you pass an
  explicit viewport that differs from the design's dimensions, the design is
  resized (bilinear) to match.

## Install & run

Requires **Node.js ≥ 20** and a Chromium binary (installed automatically the first
time via Playwright; you can also point Playwright at system Chrome).

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "perfectpixel": {
      "command": "npx",
      "args": ["-y", "mcp-perfectpixel"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "perfectpixel": {
      "command": "npx",
      "args": ["-y", "mcp-perfectpixel"]
    }
  }
}
```

### From source

```bash
pnpm install
pnpm --filter @mcp-perfectpixel/core exec playwright install chromium
pnpm build
pnpm --filter mcp-perfectpixel start
```

## Tool reference

### `capture_and_diff`

Screenshots `url`, diffs it against `designImagePath`, returns regions + artifacts.

| Argument          | Type                | Description                                                                          |
| ----------------- | ------------------- | ------------------------------------------------------------------------------------ |
| `url`             | `string` (required) | Live URL to screenshot — `http(s)` or `file` URL.                                    |
| `designImagePath` | `string` (required) | Path to the static design image (`.png`, `.jpg`, `.jpeg`).                           |
| `viewport`        | `{width, height}`   | CSS-pixel viewport. Defaults to the design image's dimensions.                       |
| `outputDir`       | `string`            | Where to write artifacts. Defaults to a fresh temp dir.                              |
| `waitForSelector` | `string`            | CSS selector to wait for before screenshotting.                                      |
| `waitMs`          | `number`            | Extra settle time after load, in ms.                                                 |
| `diffThreshold`   | `number` (0–1)      | pixelmatch sensitivity. Smaller = more sensitive. Default `0.1`.                     |
| `repoRoot`        | `string`            | Codebase root for source tracing (text-search fallback). Defaults to the server cwd. |

Example result (abridged):

```json
{
  "status": "diff",
  "similarity": 0.9951,
  "diffPixelCount": 2340,
  "totalPixelCount": 480000,
  "diffRatio": 0.0049,
  "regions": [
    {
      "id": 1,
      "x": 60,
      "y": 130,
      "width": 120,
      "height": 36,
      "pixelCount": 4120,
      "coverage": 0.99,
      "areaRatio": 0.009,
      "meanDelta": 0.52,
      "maxDelta": 0.83,
      "score": 0.58,
      "severity": "high",
      "source": {
        "element": {
          "tag": "button",
          "id": null,
          "classes": ["btn-primary"],
          "selector": "button.btn-primary",
          "computedStyle": { "background-color": "rgb(220, 38, 38)", "color": "rgb(255, 255, 255)" }
        },
        "rules": [
          {
            "selector": ".btn-primary",
            "media": null,
            "applies": true,
            "properties": ["background-color"],
            "declared": { "background-color": "#dc2626" },
            "source": {
              "file": "src/styles/_buttons.scss",
              "line": 42,
              "column": 5,
              "via": "source-map",
              "gitignored": false
            },
            "confidence": "high"
          }
        ],
        "confidence": "high",
        "patches": [
          {
            "file": "src/styles/_buttons.scss",
            "line": 42,
            "column": 5,
            "property": "background-color",
            "current": "#dc2626",
            "suggested": "var(--color-success)",
            "value": "#16a34a",
            "token": {
              "name": "--color-success",
              "reference": "var(--color-success)",
              "value": "#16a34a",
              "file": "src/styles/tokens.css",
              "line": 12,
              "kind": "css-variable"
            },
            "confidence": "high"
          }
        ]
      }
    }
  ],
  "capture": {
    "url": "https://example.com",
    "viewport": { "width": 800, "height": 600 },
    "viewportSource": "design",
    "locale": "en-US",
    "timezoneId": "UTC",
    "reducedMotion": true,
    "animationsDisabled": true,
    "fontsWaited": true,
    "durationMs": 1842
  },
  "artifacts": {
    "screenshotPath": "/var/folders/.../example.com-screenshot.png",
    "diffImagePath": "/var/folders/.../example.com-diff.png",
    "designImagePath": "/repo/designs/home.png"
  },
  "repoRoot": "/repo"
}
```

**Severity formula:** `score = 0.6·meanDelta + 0.25·coverage + 0.15·min(1, areaRatio·10)`,
with `high ≥ 0.5`, `medium ≥ 0.2`, `low < 0.2`. `meanDelta` is the mean per-pixel
perceptual color delta (YIQ-weighted, normalized 0–1), `coverage` is the fraction
of the region's bounding box that actually differs, and `areaRatio` is the
region's share of the viewport.

## Source tracing

Each diff region is resolved to a DOM element and the CSS rules styling it, and
each rule gets a best-effort original source location, in this order:

1. **CSS source maps** — the standard, build-tool-agnostic mechanism (Sass,
   Less, PostCSS, Tailwind, Webpack, Vite all emit them). The server reads each
   stylesheet's text, parses it (css-tree), maps each rule's byte offset through
   the source map, and returns the original `file:line:column` →
   `confidence: "high"`. This works regardless of what templating language
   generated the HTML, because it operates at the compiled-CSS layer.
2. **Gitignore-aware text search** — the rule's selector is searched across
   `repoRoot` with gitignore semantics (ripgrep-style: nested `.gitignore`s and
   negations respected, `node_modules` never searched). A match in a
   non-ignored file → `confidence: "medium"`; a match only in gitignored paths
   (compiled/build output) is reported but flagged `gitignored: true` and
   deprioritized → `confidence: "low"`.
3. **DOM/computed-style evidence only** — if nothing resolves, the element
   evidence is returned as-is with `confidence: "low"`. The server never guesses
   a file.

The server deliberately stops at accurate, structured signals — the calling
agent (Claude Code, Cursor, ...) reads the repo and maps `file:line:column`
hints to its own framework's conventions. Universal selectors (`*`,
`*::before`) are filtered out as non-region-specific noise.

## Minimal patches

For every traced rule that declares a color-ish property, the server derives the
design's intended value by sampling the design image at the region (dominant
opaque color), and emits the smallest possible change:

```json
{
  "file": "src/styles/_buttons.scss",
  "line": 42,
  "column": 5,
  "property": "background-color",
  "current": "#dc2626",
  "suggested": "var(--color-success)",
  "value": "#16a34a",
  "token": { "name": "--color-success", "kind": "css-variable", ... },
  "confidence": "high"
}
```

Token preference: the server scans `repoRoot` for design tokens the project
already defines — **CSS custom properties** (`--x: #hex;` in `.css`/`.scss`/
`.less`), **Tailwind configs** (`tailwind.config.{js,ts}` colors), and
**style-dictionary JSON** (`"color.success": { "value": "#16a34a" }`) — and
suggests the token reference (`var(--color-success)`) instead of a new hardcoded
value when the design color matches one. Patches are only emitted when the rule
has an anchorable source location and the declared value actually differs from
the design; layout geometry is left to the agent's judgment. The server never
proposes component rewrites — the output is always a single-property change.

## Design philosophy

- **Structured evidence, not framework knowledge.** The MCP server's job ends at
  DOM-scale regions + color deltas + severity + artifacts. It never guesses what
  generated the HTML/CSS; the calling agent owns that.
- **Determinism is a feature.** Fixed locale/timezone/color scheme, animations
  killed, fonts awaited — the same page diffed twice produces byte-identical
  screenshots, which is what makes diffing meaningful.
- **Minimal, swappable core.** The engine lives in `@mcp-perfectpixel/core`
  (framework-agnostic, no MCP dependency) so future adapters and tooling can
  reuse it without pulling in the protocol layer.

## Roadmap

- [x] **Goal 1 — Deterministic capture + pixel diff**
- [x] **Goal 2 — Trace diffs to real source** — CSS source maps first, then
      gitignore-aware text search, with confidence scoring — never a guess.
- [x] **Goal 3 — Minimal patch output** — smallest change (file, line, property,
      current → suggested), preferring tokens the project already defines.
- [x] **Goal 4 — Structured context hand-off** — the server stops at accurate
      signals; framework understanding stays with the calling agent.
- [ ] **Goal 5 — First public release** — publish `mcp-perfectpixel` on tag with
      semver from `v0.1.0`.

## Development

```bash
pnpm install
pnpm --filter @mcp-perfectpixel/core exec playwright install chromium
pnpm lint        # eslint + prettier check
pnpm build       # type-checked compile of all packages
pnpm test        # unit tests + full e2e through the MCP stdio protocol
```

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
