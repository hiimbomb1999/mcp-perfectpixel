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
- `packages/server/test/trace-cascade.e2e.test.ts` — cascade correctness:
  duplicate selectors map to their own lines, `@supports`/`@media`/
  `@container` applies, pseudo-elements never match, `!important` beats
  specificity, and a 400-rule Tailwind-like stylesheet still resolves the
  element's own rule (key-bucketed candidates).
- `packages/server/test/auth-stylesheet.e2e.test.ts` — a cookie-authenticated
  stylesheet (401 without the session cookie) is traced through the browser's
  request context, proving `page.request` carries the page's cookies.

Add fixtures as plain static HTML under `packages/server/test/fixtures/` — keep
them free of text and external assets so rendering stays deterministic across
machines. The tracing e2e generates its own HTML/CSS/source-map into a temp dir,
so no binary artifacts are committed.

## Scope guardrails (Goal 4)

The server's job stops at accurate, structured signals. Please do not add:

- **Per-framework parsers or adapters** (Liquid, Stencil, JSX, ...) — tracing
  must stay at the compiled-CSS layer + gitignore-aware text search. If a
  framework genuinely needs more, it becomes an optional community plugin.
- **Template or Figma parsing** — the tool works from flat images only.
- **Patch application** — the server reports `file:line:column` and
  `current → suggested`; it never edits files.
- **Full-component rewrites** — patch output is always a single-property change.

If you change behavior, make sure it stays framework-agnostic and add a test
that proves it (templated-looking fixtures are welcome).

## Commit & PR conventions

- Use clear, conventional commit messages (`feat:`, `fix:`, `test:`, `docs:`).
- Keep PRs focused; one logical change per PR.
- CI runs `lint`, `build`, and `test` on every push/PR — make sure all three pass.
- If you change the MCP tool schema, update the README tool reference.

## Releasing

Releases use [Changesets](https://github.com/changesets/changesets). Describe
each change as it lands with `pnpm changeset`, then apply the version bumps
and changelog entries when it's time to release:

```bash
pnpm changeset          # describe the change (choose a bump for both packages)
pnpm changeset version  # apply version bumps + changelog entries
```

Both packages must stay on the same semver. After the version commit is merged,
the publish workflow (see `.github/workflows/publish.yml`) runs on `v*` tags:

```bash
git tag v0.1.1
git push --follow-tags
```

The workflow verifies the tag matches **both** package versions, then publishes
`@mcp-perfectpixel/core` first and `mcp-perfectpixel` second (the server
tarball depends on the core version, `workspace:*` is rewritten on pack). The
`NPM_TOKEN` secret must be configured in the repo for the publish steps.

Before the first real release:

- verify `mcp-perfectpixel` is still unclaimed on npm and pick a GitHub home
  (update the `repository`/`homepage` links in both package.json files and the
  package READMEs);
- sanity-check the tarballs with `pnpm --filter <pkg> pack` (dist + README +
  LICENSE included, shebang intact, core dep rewritten to a concrete version);
- confirm the `playwright install chromium` step documented in the README works
  for consumers (the server needs a browser at capture time).
