# @mcp-perfectpixel/core

Framework-agnostic capture + pixel-diff engine behind
[`mcp-perfectpixel`](https://github.com/hiimbomb1999/mcp-perfectpixel#readme).

- Deterministic Playwright capture (fixed locale/timezone, reduced motion,
  animations disabled, fonts awaited).
- pixelmatch diff with connected-component region grouping, merging, and
  severity scoring; optional `textRegionThreshold` pass that drops text
  anti-aliasing noise.
- Region → source tracing: CSS source maps (hand-rolled source-map v3 decoder),
  then gitignore-aware text search, with confidence scoring and platform
  presets (Shopify / BigCommerce / HTML+Tailwind / React / Vue).
- Minimal patch suggestions derived from design-image pixels, preferring design
  tokens the project already defines (CSS custom properties, SCSS `$vars`,
  Tailwind config, style-dictionary JSON, Shopify `{%- schema -%}` settings) —
  with Figma-resolved tokens (`designContext.tokens`) treated as ground truth
  and Figma node boxes (`designContext.nodes`) naming each region's layer.

No MCP dependency — reuse the engine for other tooling.

## License

MIT
