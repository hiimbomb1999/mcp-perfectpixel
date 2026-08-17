# @mcp-perfectpixel/core

Framework-agnostic capture + pixel-diff engine behind
[`mcp-perfectpixel`](https://github.com/your-org/mcp-perfectpixel#readme).

- Deterministic Playwright capture (fixed locale/timezone, reduced motion,
  animations disabled, fonts awaited).
- pixelmatch diff with connected-component region grouping, merging, and
  severity scoring.
- Region → source tracing: CSS source maps (hand-rolled source-map v3 decoder),
  then gitignore-aware text search, with confidence scoring.
- Minimal patch suggestions derived from design-image pixels, preferring design
  tokens the project already defines (CSS custom properties, Tailwind config,
  style-dictionary JSON).

No MCP dependency — reuse the engine for other tooling. _(Update the repository
link before the first release.)_

## License

MIT
