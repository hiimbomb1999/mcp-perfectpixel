# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases
are versioned with [Changesets](https://github.com/changesets/changesets).

## [0.1.3] - 2026-08-19

### Added

- **Multi-viewport capture** — new `viewports` parameter accepts an array of
  `{width, height}` objects for responsive verification across breakpoints in a
  single call. Returns per-viewport results plus overall status and average
  similarity.
- **Layout dimension analysis** — when a region has no color patch (layout-only
  diff), `dimensionAnalysis` explains why dimensions differ from the design
  (line-height rounding, border-width, padding) instead of forcing the agent to
  guess pixel values.
- **Design image hash** — `artifacts.designImageHash` (SHA-256) enables
  determinism verification and cache-busting detection.
- **Text noise filter structured output** — `textNoiseFilter` field with
  `droppedRegions` array shows which regions were dropped and why, instead of
  just a warning string.
- **CSS `@layer` support** — rules inside `@layer` blocks are tracked with a
  `layer` field in `RuleEvidence` for correct cascade ordering.
- **Tailwind v4 `@theme` support** — design tokens are now scanned from
  `@theme` blocks in CSS files, not just `tailwind.config.*`.

### Fixed

- **Output schema missing `notes` field** — `notes` (responsive guidance,
  inheritance explanations, culprit hints) was silently stripped from
  `structuredContent` by Zod's default unknown-key behavior. Now included in
  the output schema.
- **Error response missing `structuredContent`** — when capture throws an
  error, the response now includes a full `structuredContent` matching the
  output schema (with zeroed defaults) so clients relying on typed output don't
  get `undefined`.

## [0.1.2] - 2026-08-18

The design-context release: verification now speaks the project's own token
and layer vocabulary. Every new input is optional — existing clients that only
send `url` + `designImagePath` are unaffected, and no new runtime dependencies
were added.

### Added

- **`platform` input** (`shopify` | `bigcommerce` | `html-tailwind` | `react` |
  `vue` | `auto`) — narrows source search to platform file globs and enables
  platform-specific token scanning: SCSS `$vars` for BigCommerce themes and
  `{%- schema -%}` color settings for Shopify themes.
- **`designContext.scale`** — normalizes 1x/2x/3x Figma exports so the capture
  viewport matches the Figma frame and design pixels line up with capture
  pixels.
- **`designContext.tokens`** — Figma-resolved tokens are treated as ground
  truth: a token whose color matches the design value wins the patch
  suggestion (`suggested` / `figmaToken`), while a repo token matching the
  same value is still reported alongside.
- **`designContext.nodes`** — Figma node boxes annotate each diff region with
  `figmaNode`, the layer whose box best overlaps the region
  (intersection-over-region-area; ties go to the tighter node).
- **`textRegionThreshold`** — text-like regions (high color variance in the
  design crop, or a text-named Figma node) whose diff disappears under this
  more lenient pixelmatch threshold are dropped as anti-aliasing noise;
  dropped counts surface in `trace.warnings`.
- **Session-scoped file cache** — repeated captures stat and read each repo
  file at most once (selector search + token scan share a single cache).
- **CI publish smoke test** — after publishing, installs the published package
  via `npx` and verifies it answers the MCP `initialize` handshake.

### Changed

- Publish pipeline now uses npm Trusted Publishing (OIDC) with provenance —
  no NPM token, no OTP.

## [0.1.1] - 2026-08-17

First npm release. Implements the core verification loop:

- **Deterministic capture + pixel diff** — headless Chromium with animations
  disabled, fonts awaited, fixed locale/timezone/color scheme; diffs against a
  static design image (local file or Figma export URL) and returns grouped
  diff regions with severity scores (`high` / `medium` / `low`).
- **Source tracing** — every region resolves to its DOM element and the CSS
  rules styling it, located via per-rule CSS source maps first, then
  gitignore-aware text search, each with a confidence score.
- **Cascade-aware minimal patches** — a single `file:line:column` +
  `current → suggested` patch per region that targets the cascade winner
  (specificity, order, `!important`) and prefers design tokens the project
  already defines (CSS variables, Tailwind config, style-dictionary).
- **Structured MCP output** — a typed `structuredContent` schema for
  `capture_and_diff`, with `trace.status` / `trace.warnings` so tracing issues
  are never silently swallowed.
- **Hardening** — resource limits (viewport/wait/image size/region caps), a
  local/hosted trust boundary with SSRF protection, session-aware stylesheet
  fetching through the browser's request context, secrets hygiene, and
  Gitleaks scanning in CI.
