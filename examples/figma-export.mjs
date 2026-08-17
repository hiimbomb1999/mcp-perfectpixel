/* global URL, fetch, Buffer, process, console */
/**
 * Export a Figma node (frame) to a local PNG/JPG design image, so it can be
 * passed to mcp-perfectpixel's capture_and_diff (or examples/demo.mjs).
 *
 * This is the standalone companion to the Figma MCP workflow: the Figma MCP
 * server (mcp.figma.com) hands you an export URL for a node — this script
 * turns a Figma design URL or (file key, node id) pair into that local file
 * via the Figma REST API.
 *
 * Usage (a Figma personal access token is required):
 *
 *   FIGMA_TOKEN=figd_... node examples/figma-export.mjs \
 *     "https://www.figma.com/design/WNtRe4ND67vCwA0TvIShFk/...?node-id=1689-7871" \
 *     -o /tmp/design.png -f png -s 1
 *
 *   # or with an explicit file key + node id:
 *   FIGMA_TOKEN=figd_... node examples/figma-export.mjs \
 *     WNtRe4ND67vCwA0TvIShFk 1689-7871 -o /tmp/design.png
 *
 * Options: -o <file> (default ./design.png), -f <png|jpg> (default png),
 *          -s <1|2|3> pixel scale (default 1; use 2 for high-DPI designs).
 */
const API = 'https://api.figma.com/v1';

function parseArgs(argv) {
  const positional = [];
  const opts = { out: 'design.png', format: 'png', scale: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o') opts.out = argv[++i];
    else if (a === '-f') opts.format = argv[++i];
    else if (a === '-s') opts.scale = Number(argv[++i]);
    else positional.push(a);
  }
  return { positional, opts };
}

function extractFileKeyAndNode(input, explicitNode) {
  if (/^https?:\/\//i.test(input)) {
    const url = new URL(input);
    const parts = url.pathname.split('/'); // /design/<fileKey>/<slug>
    const fileKey = parts[2];
    const node = explicitNode ?? url.searchParams.get('node-id');
    if (!fileKey || !node) {
      throw new Error(
        `Could not parse Figma URL — expected /design/<fileKey>/...?node-id=<id>, got "${input}"`,
      );
    }
    return { fileKey, node };
  }
  if (!explicitNode) {
    throw new Error('Provide a Figma URL, or a file key AND node id as two arguments');
  }
  return { fileKey: input, node: explicitNode };
}

async function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const [first, second] = positional;
  if (!first) {
    console.error(
      'Usage: FIGMA_TOKEN=<token> node examples/figma-export.mjs <figmaUrl|fileKey> [nodeId] [-o out.png] [-f png|jpg] [-s scale]',
    );
    process.exit(1);
  }
  const token = process.env.FIGMA_TOKEN;
  if (!token) {
    console.error(
      'No FIGMA_TOKEN found. Create one at https://www.figma.com/developers/api#access-tokens and export it:',
      '  export FIGMA_TOKEN=figd_...',
    );
    process.exit(1);
  }
  const { fileKey, node } = extractFileKeyAndNode(first, second);
  if (!['png', 'jpg'].includes(opts.format)) {
    console.error('Format must be png or jpg');
    process.exit(1);
  }

  const url = `${API}/images/${fileKey}?ids=${encodeURIComponent(node)}&format=${opts.format}&scale=${opts.scale}`;
  const res = await fetch(url, { headers: { 'X-Figma-Token': token } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`Figma API ${res.status}: ${body.slice(0, 300) || res.statusText}`);
    process.exit(1);
  }
  const json = await res.json();
  const imageUrl = json.images?.[node];
  if (!imageUrl) {
    console.error(`Figma returned no image for node "${node}" — is it exported/visible?`);
    process.exit(1);
  }

  const img = await fetch(imageUrl);
  if (!img.ok) {
    console.error(`Failed to download image: HTTP ${img.status}`);
    process.exit(1);
  }
  const { writeFile } = await import('node:fs/promises');
  await writeFile(opts.out, Buffer.from(await img.arrayBuffer()));
  console.log(`Wrote ${opts.out} (${fileKey} node ${node}, ${opts.format}@${opts.scale}x)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
