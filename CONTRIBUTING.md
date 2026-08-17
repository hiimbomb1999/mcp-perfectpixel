# Contributing to mcp-perfectpixel

Thanks for contributing! This project follows standard open-source conventions:
everything is reviewed via pull requests, and releases are cut from tags.

## Development setup

Prerequisites: Node.js ≥ 20 and [pnpm](https://pnpm.io) 9+.

```bash
pnpm install
pnpm --filter @mcp-perfectpixel/core exec playwright install chromium
```

The repo is a pnpm workspaces monorepo:

- `packages/core` — `@mcp-perfectpixel/core`: the framework-agnostic capture +
  diff engine (no MCP dependency).
- `packages/server` — `mcp-perfectpixel`: the MCP stdio server exposing
  `capture_and_diff`.

## Scripts

| Script           | What it does                                             |
| ---------------- | -------------------------------------------------------- |
| `pnpm lint`      | ESLint + Prettier check across the repo                  |
| `pnpm format`    | Apply Prettier formatting                                |
| `pnpm build`     | Type-check and compile every package to `dist/`          |
| `pnpm typecheck` | Type-check without emitting                              |
| `pnpm test`      | Build all packages, then run unit + e2e tests via Vitest |

The e2e test spawns the **built** server (`packages/server/dist/index.js`) over
stdio, so always build before testing — `pnpm test` does this for you.

## Tests

- `packages/core/test/diff.test.ts` — synthetic-buffer unit tests for diffing,
  region grouping, merging, severity buckets, resize, and image decoding.
- `packages/core/test/sourcemap.test.ts` — source-map v3 unit tests: base64 VLQ
  decode, `mappings` decoding, generated-offset → original-position lookup, and
  `sourceMappingURL` extraction.
- `packages/core/test/search.test.ts` — gitignore-aware search unit tests:
  nested/negated `.gitignore` patterns, non-ignored-vs-gitignored ranking, and
  node_modules exclusion.
- `packages/server/test/e2e.test.ts` — full-stack test: an MCP client calls
  `capture_and_diff` on the real server against a deterministic fixture page,
  asserting region geometry/severity, source tracing via text search, the
  pixel-identical match case, and byte-identical re-captures.
- `packages/server/test/trace.e2e.test.ts` — source-tracing e2e: a generated
  page whose compiled CSS carries a `data:` source map (VLQ-encoded in the
  test) resolves rules to `src/_page.scss:line:column` with high confidence;
  an inline-styled element resolves to DOM evidence with low confidence.

Add fixtures as plain static HTML under `packages/server/test/fixtures/` — keep
them free of text and external assets so rendering stays deterministic across
machines. The tracing e2e generates its own HTML/CSS/source-map into a temp dir,
so no binary artifacts are committed.

## Commit & PR conventions

- Use clear, conventional commit messages (`feat:`, `fix:`, `test:`, `docs:`).
- Keep PRs focused; one logical change per PR.
- CI runs `lint`, `build`, and `test` on every push/PR — make sure all three pass.
- If you change the MCP tool schema, update the README tool reference.

## Releasing

Releases are cut by pushing a tag (see `.github/workflows/publish.yml`):

```bash
pnpm -C packages/server version 0.1.1   # bumps and tags
git push --follow-tags
```

The workflow verifies the tag matches the package version, then publishes
`mcp-perfectpixel` to npm. The `NPM_TOKEN` secret must be configured in the repo
for the publish step. The package name is a placeholder — verify it is still
unclaimed on npm/GitHub before the first real release.
