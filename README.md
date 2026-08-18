# mcp-perfectpixel

[![npm version](https://img.shields.io/npm/v/mcp-perfectpixel.svg)](https://www.npmjs.com/package/mcp-perfectpixel)
[![CI](https://github.com/hiimbomb1999/mcp-perfectpixel/actions/workflows/ci.yml/badge.svg)](https://github.com/hiimbomb1999/mcp-perfectpixel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/hiimbomb1999/mcp-perfectpixel/blob/main/LICENSE)

> **The missing verification layer for AI design-to-code workflows.**

`mcp-perfectpixel` is an [MCP](https://modelcontextprotocol.io) server that
screenshots a live URL and diffs it against a static design image (PNG/JPG),
returning **grouped diff regions with severity scores** — not raw pixel noise —
each traced to its DOM element, real source location, and a minimal patch
suggestion. Capture is **deterministic** (animations disabled, fonts fully
loaded, fixed locale/timezone), so re-runs are stable enough to reason about
pixel-by-pixel.

It is a _verification_ tool, not a design tool: it does not read Figma files,
does not generate code, and does not know what framework you use. It closes the
loop the other MCP tools leave open — _"did the final result actually match the
design?"_

## Why this exists

Shipping pixel-perfect themes for **BigCommerce, Shopify, WordPress and landing
pages** usually goes like this: the build itself is fast, but the final
**"does it match the design"** pass is a slow, manual, zoom-and-compare chore —
and it is exactly the step AI coding agents get wrong (wrong spacing, off-by-one
colors, missing tokens).

`mcp-perfectpixel` automates that verification loop: screenshot the live URL,
diff against the design image, get grouped regions + source locations + minimal
patches, fix, and re-run until `similarity: 1.0`. The calling agent (Claude
Code, Cursor, DeepSeek Agent, Codex) applies the fixes — the server supplies
accurate, structured evidence and stops there.

## Where it fits

Three MCP servers, three moments of the design-to-code loop — they complement,
not compete:

|               | **Figma MCP**                                                                 | **Chrome DevTools MCP**                                                      | **mcp-perfectpixel**                                                                        |
| ------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Gives you** | Structured design data — node tree, styles, variables, tokens, generated code | Live DOM / CSS / console / network debugging of the running page             | Pixel-level verification — diff of the final render against the design image                |
| **Use it**    | **Before** writing code — _what should I build, what are the exact styles?_   | **During** development — _why is it behaving like this, fix runtime issues?_ | **After** implementing — _does the final result actually match the design, pixel by pixel?_ |
| **Answers**   | What's in the design?                                                         | What's happening on the page?                                                | Did we nail the design?                                                                     |

`mcp-perfectpixel` is deliberately **not** a Figma MCP competitor: it never
touches Figma. It takes the flat image Figma MCP can hand it (or any PNG/JPG)
and verifies the _rendered result_ — the step neither of the other two covers.

## Features

- **Deterministic capture** — headless Chromium with animations/transitions
  disabled, `prefers-reduced-motion` forced, all web fonts awaited
  (`document.fonts.ready`), fixed `en-US` locale + UTC timezone, light scheme,
  `deviceScaleFactor: 1`. Two runs produce byte-identical screenshots.
- **Grouped diff regions** — differing pixels are clustered and nearby clusters
  merged, so you get _"the button is wrong"_, not 4,000 scattered pixels. Each
  region carries a bounding box, pixel count, color deltas, and a severity
  score (`high` / `medium` / `low`).
- **Region → source tracing** — every region resolves to its DOM element and the
  CSS rules styling it, each with a best-effort original
  `file:line:column` (CSS source maps first, then gitignore-aware text search)
  and a confidence score.
- **Minimal patches** — the smallest single-property change
  (`file, line, property, current → suggested`), preferring design tokens the
  project already defines (`var(--color-success)`, not a hardcoded hex). Never
  a component rewrite.
- **Artifacts on disk** — screenshot + highlighted diff image (PNG) written to
  an output dir and returned, so the agent can inspect them.
- **Token-friendly output** — typed `structuredContent` (declared output
  schema), trimmed computed style, rounded floats; ~37% smaller payloads.
- **Works with any stack** — tracing operates at the compiled-CSS layer + text
  search, so Liquid, Stencil, Twig, JSX, Blade, Razor or plain HTML all behave
  identically. No per-framework parsers.

## Install & run

Requires **Node.js ≥ 20** and a Chromium binary (install once):

```bash
npx playwright install chromium
```

### Claude Desktop — `claude_desktop_config.json`

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

### Cursor — `.cursor/mcp.json`

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

### Codex CLI — `~/.codex/config.toml`

```toml
[mcp_servers.mcp-perfectpixel]
command = "npx"
args = ["-y", "mcp-perfectpixel"]
```

(Requires Node.js ≥ 20 and `npx playwright install chromium` on the machine
running Codex. `repoRoot` defaults to the session's working directory — your
project — so tracing and token lookup run against the code you're editing.
Restart Codex after editing. To run from source instead, point `command`/`args`
at your local `node` + `packages/server/dist/index.js`.)

### Try it locally (no client needed)

```bash
pnpm install
pnpm --filter @mcp-perfectpixel/core exec playwright install chromium
pnpm build

# one command: renders the fixture design, diffs the fixture page, prints everything
node examples/demo.mjs packages/server/test/fixtures/design.html \
  "file://$PWD/packages/server/test/fixtures/page.html"
```

`examples/demo.mjs` calls the engine directly with your own design image/URL:
`node examples/demo.mjs <design.png|design.html> <url> [repoRoot]`.

## Tool reference

### `capture_and_diff`

Screenshots `url`, diffs it against `designImagePath`, returns regions + artifacts.

| Argument              | Type                                                                          | Description                                                                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`                 | `string` (required)                                                           | Live URL to screenshot — `http(s)` or `file` URL.                                                                                                                                               |
| `designImagePath`     | `string` (required)                                                           | Design image (`.png`, `.jpg`, `.jpeg`) **or an http(s) image URL** (e.g. a Figma export link).                                                                                                  |
| `viewport`            | `{width, height}`                                                             | CSS-pixel viewport. Defaults to the design image's dimensions.                                                                                                                                  |
| `outputDir`           | `string`                                                                      | Where to write artifacts. Defaults to a fresh temp dir.                                                                                                                                         |
| `waitForSelector`     | `string`                                                                      | CSS selector to wait for before screenshotting.                                                                                                                                                 |
| `waitMs`              | `number`                                                                      | Extra settle time after load, in ms (≤ 60s).                                                                                                                                                    |
| `diffThreshold`       | `number` (0–1)                                                                | pixelmatch sensitivity. Smaller = more sensitive. Default `0.1`.                                                                                                                                |
| `repoRoot`            | `string`                                                                      | Codebase root for source tracing. Defaults to the server cwd (required in `hosted` mode).                                                                                                       |
| `mode`                | `"local" \| "hosted"`                                                         | Trust boundary: `local` (default) allows `file://`/local paths; `hosted` blocks them + private networks (SSRF guard).                                                                           |
| `computedStyle`       | `"minimal" \| "full" \| "none"`                                               | Computed-style verbosity per region. `minimal` (default) keeps color candidates + values differing from the parent.                                                                             |
| `platform`            | `"shopify" \| "bigcommerce" \| "html-tailwind" \| "react" \| "vue" \| "auto"` | Codebase type — narrows source-search priority globs and enables platform token scanning (SCSS `$vars`, Shopify `{%- schema -%}` settings). Default `"auto"`: detected from `repoRoot` markers. |
| `designContext`       | `{ scale?, tokens?, nodes? }`                                                 | Design metadata from Figma: export `scale` (1/2/3) to align the viewport with the frame; resolved `tokens` (matched before repo tokens); `nodes` bounding boxes to name each region's layer.    |
| `textRegionThreshold` | `number` (0–1)                                                                | Extra lenient pixelmatch threshold for text-like regions (high color variance). Regions whose diff disappears under it are dropped as anti-aliasing noise. Default: unset (no filtering).       |

The tool declares an **output schema**: MCP clients receive typed
`structuredContent` (validated) plus the JSON text. Every call reports
`trace.status` (`skipped`/`ok`/`partial`/`failed`) and `trace.warnings` — issues
are never silently swallowed.

Example result (abridged):

```json
{
  "status": "diff",
  "similarity": 0.9951,
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
      "meanDelta": 0.52,
      "score": 0.58,
      "severity": "high",
      "figmaNode": "Home/CTA/Button",
      "source": {
        "element": {
          "tag": "button",
          "id": null,
          "classes": ["btn-primary"],
          "selector": "button.btn-primary",
          "computedStyle": { "background-color": "rgb(220, 38, 38)" }
        },
        "rules": [
          {
            "selector": ".btn-primary",
            "media": null,
            "supports": null,
            "container": null,
            "applies": "yes",
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
              "kind": "css-variable"
            },
            "figmaToken": {
              "name": "Success/500",
              "value": "#16a34a",
              "kind": "color"
            },
            "confidence": "high"
          }
        ],
        "notes": []
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
    "designImagePath": "/repo/designs/home.png",
    "designImageSource": "/repo/designs/home.png"
  },
  "trace": { "status": "ok", "warnings": [] },
  "repoRoot": "/repo"
}
```

**Severity:** `score = 0.6·meanDelta + 0.25·coverage + 0.15·min(1, areaRatio·10)`,
`high ≥ 0.5`, `medium ≥ 0.2`, `low < 0.2`.

### Platform presets

`platform` tells the tracer which codebase it is looking at so source search and
token scanning are prioritized correctly instead of being generic:

| Platform            | What changes                                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"shopify"`         | `{%- schema -%}` color settings in `.liquid` files become design tokens (`settings.color_primary`), and Liquid files rank first in text search.                  |
| `"bigcommerce"`     | SCSS `$vars` (e.g. `$primary-color`) in `.scss` files become design tokens, and Stencil `templates/` is treated as source.                                       |
| `"html-tailwind"`   | Tailwind config files are scanned for tokens; plain HTML/CSS search order.                                                                                       |
| `"react"` / `"vue"` | Source-search ordering favors JSX/Vue SFC style blocks; `.vue` matches rank as `vue-sfc-style`.                                                                  |
| `"auto"` (default)  | Detected from `repoRoot` markers (`.liquid` → Shopify, `stencil.conf.json` → BigCommerce, `package.json` deps → React/Vue, `tailwind.config.*` → HTML+Tailwind). |

You only need to set it when the project mixes markers or the detection is
ambiguous.

### Design context (from Figma)

The tool works from flat images, but the agent usually has richer design data
available (via Figma MCP). Pass it through `designContext` — every field is
optional and best-effort:

```json
{
  "platform": "shopify",
  "designImagePath": "https://figma-export/.../frame@2x.png",
  "designContext": {
    "scale": 2,
    "tokens": [
      { "name": "Success/500", "value": "#16a34a", "kind": "color" },
      { "name": "Space/4", "value": "4px", "kind": "spacing" }
    ],
    "nodes": [{ "name": "Home/CTA/Button", "x": 60, "y": 130, "width": 120, "height": 36 }]
  }
}
```

- **`scale`** (1/2/3) — the export scale of the design image relative to the
  Figma frame. The viewport is derived by dividing the image dimensions by the
  scale, so the capture matches the frame and region coordinates line up with
  Figma's node boxes. Without it, an `@2x` export would make the page capture
  twice as wide as the frame.
- **`tokens`** — Figma-resolved variables/styles. They are treated as ground
  truth: when a token's color matches the design value, its **name** wins the
  patch suggestion (`figmaToken` in the output) and a repo token matching the
  same value is still reported alongside (`token`).
- **`nodes`** — Figma node bounding boxes (design-image space). Each diff
  region is annotated with `figmaNode`, the name of the layer whose box covers
  the largest fraction of the region's bounding box (ties go to the tighter
  node). Text-named nodes (`text|label|title|price|desc|heading|body`) also
  feed the `textRegionThreshold` noise filter.

### `textRegionThreshold` (anti-aliasing noise)

A design's text and the live page's text are rarely rendered identically —
different fonts, weights, or hinting produce small anti-aliasing differences
that show up as noisy regions. When set, `textRegionThreshold` acts as a second,
**more lenient** pixelmatch threshold applied only to text-like regions (high
color variance in the design crop, or an overlapping text-named Figma node):
any such region whose diff disappears under it is dropped as AA noise. Non-text
regions are never affected, and the count of dropped regions is reported in
`trace.warnings` — best-effort, never silent.

```json
{ "textRegionThreshold": 0.2 }
```

## How it works

1. **Capture** — the URL is screenshotted deterministically (animations killed,
   fonts awaited, fixed locale/timezone).
2. **Diff** — the screenshot is diffed against the design image (pixelmatch);
   differing pixels are clustered into connected regions, merged when close,
   and scored by severity.
3. **Trace** — each region's element and its CSS rules are resolved to real
   source locations: CSS source maps first, then gitignore-aware text search,
   then plain DOM evidence — never a guessed file.
4. **Patch** — the design color is sampled from the image at the region, the
   cascade winner (specificity / order / `!important`) is found, and the
   smallest change is suggested, preferring the project's own design tokens.

### Source tracing order

1. **CSS source maps** — the standard build-tool-agnostic mechanism (Sass,
   Less, PostCSS, Tailwind, Webpack, Vite all emit them). Each rule's byte
   offset maps through the source map to the original `file:line:column` →
   `confidence: "high"`. Works regardless of the templating language, because it
   operates at the compiled-CSS layer.
2. **Gitignore-aware text search** — the selector is searched across `repoRoot`
   (nested `.gitignore`s and negations respected, `node_modules` never
   searched). Non-ignored source → `"medium"`; matches only in gitignored
   (build) paths → `"low"`; matches in test/docs files are deprioritized.
3. **DOM evidence only** — if nothing resolves, the element + computed style
   are returned as-is with `confidence: "low"`.

### Minimal patches

For color diffs the server derives the design's intended value by sampling the
design image at the region and emits **one** smallest-possible change,
preferring tokens the project already defines — CSS custom properties,
Tailwind configs, style-dictionary JSON:

```json
{
  "file": "src/styles/_buttons.scss",
  "line": 42,
  "column": 5,
  "property": "background-color",
  "current": "#dc2626",
  "suggested": "var(--color-success)",
  "value": "#16a34a",
  "confidence": "high"
}
```

When a patch has no anchor (e.g. the culprit color is inherited from an
ancestor, or set by an inline style), the result explains it in `notes[]`
instead of guessing.

## Responsive design (avoid hardcoded width/height)

A design **image is a single-viewport raster** — it cannot encode breakpoints,
auto-layout or fluid behavior. Copying pixel dimensions out of it into
`width: 120px; height: 36px` is the fastest way to break a real theme on other
viewports. `mcp-perfectpixel` is designed so this doesn't happen by accident:

- **It never suggests width/height patches** — patches are color-only
  (`background-color`, `color`, borders, outline). Layout is never "fixed" by
  the tool.
- **`capture.responsive` reports the page's own breakpoints** — the distinct
  `@media` / `@container` condition counts across all stylesheets. Non-zero
  means the page is responsive, and any px dimensions in the output are
  viewport-specific.
- **`notes[]` warns when it matters**: if an element renders at fixed px
  dimensions while the page uses media/container queries, or when a diff is
  geometry-only (no color change), the region note says so and tells the agent
  to prefer fluid sizing (`min/max-width`, flex/grid, spacing tokens) and to
  re-run the capture at other viewports to verify.
- **The values are still accurate** — `width`/`height` in the computed style
  are the real rendered values at the capture viewport; they are evidence, not
  instructions.

For responsive _intent_, pair this tool with **Figma MCP's structured data**
(auto-layout, constraints, variables) — the raster verifies the pixels, the
structured data informs the layout strategy.

## Designs from Figma

`mcp-perfectpixel` works from **flat images only** — the [official Figma Dev
Mode MCP](https://www.figma.com/developers/docs/dev-mode/mcp) is the perfect
bridge: it exports any frame/node to an image, and this server verifies the
final render against it. The agent orchestrates both; `mcp-perfectpixel` never
talks to Figma itself.

**Workflow — "implement this design from Figma":**

1. **Figma MCP** — export the node (`get_image`-style tool) → an image URL;
   optionally read the frame's variables/styles and node boxes.
2. **mcp-perfectpixel** — `capture_and_diff` with `designImagePath` = that URL
   (fetched automatically), `url` = the live page, `repoRoot` = the codebase —
   and `designContext` (`scale`, `tokens`, `nodes`) when available so patches
   speak the project's own token names and regions carry Figma layer names
   (see [Design context](#design-context-from-figma)).
3. Apply the returned regions + patches, re-run until `similarity: 1.0`.

**Standalone export** (no Figma MCP needed):

```bash
export FIGMA_TOKEN=figd_...   # create at https://www.figma.com/developers/api#access-tokens
node examples/figma-export.mjs \
  "https://www.figma.com/design/FILE_KEY/slug?node-id=1689-7871" -o /tmp/design.png

node examples/demo.mjs /tmp/design.png https://localhost:3000
```

## Design philosophy

- **Structured evidence, not framework knowledge.** The server's job ends at
  regions + element + rules + confidence + patches. It never guesses what
  generated the HTML/CSS — the calling agent owns that.
- **Determinism is a feature.** Same page, same design, same bytes — which is
  what makes pixel diffing meaningful.
- **Minimal, swappable core.** The engine lives in `@mcp-perfectpixel/core`
  (framework-agnostic, no MCP dependency), so future tooling can reuse it.

### The boundary (what the server will never do)

- parse templates or Figma files — tracing works at the compiled-CSS layer;
- maintain per-framework parsers/adapters (Liquid, Stencil, ...) — at most an
  optional community plugin, never a core dependency;
- propose full component rewrites — output is always a single-property change;
- apply patches or edit files itself — it reports
  `file:line:column` + `current → suggested`, the agent decides.

**Explicitly out of scope** (no `apply_patch` tool, read-only/advisory by
design):

- **No `apply_patch` tool** — this server only reports evidence; applying
  changes is the calling agent's job (and its review loop).
- **No ignore regions** — you cannot mark areas of the design as "dynamic
  content" (cookie banners, live clocks, carousels) to skip them. Filter with
  `diffThreshold`/`textRegionThreshold` or exclude the element before capture.
- **No auth headers** — the capture sends no extra headers and sets no cookies
  (session-aware _stylesheet_ fetching uses only the page's own context).
- **No pseudo-element / container-query runtime evaluation** — `::before` /
  `::after` rules never match the element, and `@container` conditions report
  `applies: "unknown"` (there is no standards API to evaluate them per element).

## Hardening

- **Cascade-correct patches** — specificity, declaration order, `!important`;
  duplicate selectors map to their own source positions.
- **Conditional CSS** — `@media` via `matchMedia()`, `@supports` via
  `CSS.supports()`, `@container` reported as `applies: "unknown"`; pseudo-element
  rules never match the element.
- **Resource limits** — viewport ≤ 16.7M px, design ≤ 50MB (stat before read),
  ≤ 50 regions, bounded candidate selectors, fetch timeouts, capped file scans.
- **Trust boundary** — `mode: "local"` / `"hosted"` with SSRF + `file://`
  protection and an explicit `repoRoot` requirement.
- **Session-aware stylesheets** — fetched through the browser's request context,
  so cookies apply and the traced CSS matches what the page rendered.
- **Honest tracing** — `trace.status`/`warnings` report failures and
  truncations; text-search matches in tests/docs/generated files are
  deprioritized.
- **Design-context aware** — Figma tokens win patch suggestions (ground truth),
  node boxes name each region (`figmaNode`), and text anti-aliasing noise is
  filterable via `textRegionThreshold`.
- **Token-friendly output** — rounded floats, trimmed computed style, shared
  repo-walk cache with parallel reads (~37% smaller payloads, ~58% faster).
- **Secret hygiene** — `.env`/`.npmrc` gitignored; CI runs Gitleaks, lint,
  build, tests and coverage; the publish workflow re-runs everything before
  releasing.

## Roadmap

- [x] **Goal 1 — Deterministic capture + pixel diff**
- [x] **Goal 2 — Trace diffs to real source** (CSS source maps → gitignore-aware
      text search, with confidence scoring)
- [x] **Goal 3 — Minimal patch output** preferring the project's own tokens
- [x] **Goal 4 — Structured context hand-off** (no framework knowledge)
- [x] **Goal 5 — OSS conventions + release pipeline** (semver from `v0.1.0`,
      publish-on-tag for both packages)

Releases are cut from git tags (`v0.1.0`, `v0.1.1` published). The publish
workflow uses **npm Trusted Publishing (OIDC) with provenance** — no `NPM_TOKEN`,
no OTP — and smoke-tests the published package via `npx` before finishing. See
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Development

```bash
pnpm install
pnpm --filter @mcp-perfectpixel/core exec playwright install chromium
pnpm lint        # eslint + prettier
pnpm build       # type-checked compile of both packages
pnpm test        # 132 unit + e2e tests through the MCP stdio protocol
pnpm coverage    # vitest coverage (v8)
```

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
