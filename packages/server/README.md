# mcp-perfectpixel

**Codebase-grounded design-to-code diff server for the Model Context Protocol.**

Screenshot a live URL, diff it against a static design image (PNG/JPG), and get
grouped diff regions with severity scores — each traced to its DOM element and
real source location (CSS source maps, then gitignore-aware text search), plus
minimal patch suggestions that prefer the project's own design tokens.

Capture is deterministic: animations disabled, fonts fully loaded, fixed
locale/timezone, so re-runs are pixel-stable.

## Usage (MCP)

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

### Direct

```bash
npx mcp-perfectpixel
```

## Tool

`capture_and_diff` — arguments: `url`, `designImagePath`, optional `viewport`,
`outputDir`, `waitForSelector`, `waitMs`, `diffThreshold`, `repoRoot`.

Returns `status`, `similarity`, grouped `regions` (each with severity, DOM
element, matched CSS rules + source locations + confidence, and minimal
`patches`), capture determinism info, and artifact paths.

See the repository [README](https://github.com/hiimbomb1999/mcp-perfectpixel#readme)
for the full tool reference, source-tracing design, and roadmap.

## License

MIT
