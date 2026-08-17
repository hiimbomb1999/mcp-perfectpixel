# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases
are versioned with [Changesets](https://github.com/changesets/changesets).

## Unreleased

Initial pre-release state — nothing has been published to npm yet (no version
entries exist). The current codebase implements:

- **Deterministic capture + pixel diff** — screenshots a URL in headless
  Chromium with animations disabled, fonts awaited, and fixed locale/timezone;
  diffs against a static design image and returns grouped diff regions with
  severity scores (`high` / `medium` / `low`).
- **Source tracing** — every region resolves to its DOM element and the CSS
  rules styling it, located via CSS source maps first, then gitignore-aware
  text search, each with a confidence score.
- **Minimal token-aware patches** — single-property `file:line:column` +
  `current → suggested` suggestions that target the cascade winner and prefer
  design tokens the project already defines.
- **Structured MCP output** — a typed `structuredContent` schema for
  `capture_and_diff`, with `trace.status` / `trace.warnings` so tracing issues
  are never silently swallowed.
- **Hardening** — resource limits (viewport/wait/image size/region caps),
  a local/hosted trust boundary with SSRF protection, and session-aware
  stylesheet fetching through the browser's request context.
