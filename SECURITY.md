# Security Policy

## Supported versions

The project is pre-1.0 and only the current minor line receives security fixes:

| Version | Supported        |
| ------- | ---------------- |
| 0.1.x   | ✅ Supported     |
| < 0.1   | ❌ Not supported |

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Instead, report
privately:

- **Preferred:** open a [GitHub Security Advisory](https://github.com/advisories/new)
  ("Report a vulnerability" on the repo's Security tab) once the repository
  exists — select "Private vulnerability reporting" so the report is only
  visible to maintainers.
- **Alternative:** email the maintainers directly (addresses are listed on the
  repository profile / package metadata once published).

## Scope

In scope:

- The MCP stdio server (`packages/server`) — tool input handling, output
  schema, trust boundary (`local` / `hosted`) enforcement, SSRF protections.
- The capture/tracing engine (`packages/core`) — URL fetching, stylesheet
  loading, file reading, gitignore-aware text search, resource limits.

Out of scope:

- Dependencies of the project (report those to their own maintainers).
- Security of the calling agent (Claude Desktop, Cursor, Codex, ...) or the
  browser itself.

## Expectations

- **No public disclosure before a fix** — please give maintainers time to
  address the issue before it becomes public.
- **Response within 7 days** — maintainers will acknowledge the report within
  7 days and keep you updated on the fix and release timeline.
- If the report is valid, a security fix ships in a patch release
  (0.1.x) as soon as possible; you will be credited (if you wish).
