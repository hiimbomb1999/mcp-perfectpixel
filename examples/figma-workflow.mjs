#!/usr/bin/env node
/* global process, console, fetch, Buffer, URL */
/**
 * Complete Figma MCP → PerfectPixel workflow example.
 *
 * This script demonstrates the recommended integration pattern:
 * 1. Export a Figma node as a design image
 * 2. Extract Figma variables/styles as design tokens
 * 3. Extract node bounding boxes for region annotation
 * 4. Call PerfectPixel with full designContext
 * 5. Interpret results and map regions back to Figma layers
 *
 * Usage:
 *   FIGMA_TOKEN=figd_... node examples/figma-workflow.mjs \
 *     "https://www.figma.com/design/FILE_KEY/slug?node-id=1689-7871" \
 *     "http://localhost:3000" \
 *     -o /tmp/design.png
 *
 * Prerequisites:
 *   - Figma personal access token (https://www.figma.com/developers/api#access-tokens)
 *   - PerfectPixel MCP server running or @mcp-perfectpixel/core installed
 *   - A live page to compare against the design
 */

const API = 'https://api.figma.com/v1';

// ============================================================================
// Step 1: Export Figma node as design image
// ============================================================================

async function exportFigmaNode(fileKey, nodeId, scale = 2) {
  const token = process.env.FIGMA_TOKEN;
  if (!token) {
    throw new Error('FIGMA_TOKEN environment variable is required');
  }

  console.log(`[1/5] Exporting Figma node ${nodeId} at ${scale}x scale...`);

  const url = `${API}/images/${fileKey}?ids=${encodeURIComponent(nodeId)}&format=png&scale=${scale}`;
  const res = await fetch(url, { headers: { 'X-Figma-Token': token } });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Figma API ${res.status}: ${body.slice(0, 300) || res.statusText}`);
  }

  const json = await res.json();
  const imageUrl = json.images?.[nodeId];
  if (!imageUrl) {
    throw new Error(`Figma returned no image for node "${nodeId}"`);
  }

  const img = await fetch(imageUrl);
  if (!img.ok) {
    throw new Error(`Failed to download image: HTTP ${img.status}`);
  }

  const { writeFile } = await import('node:fs/promises');
  const outputPath = `/tmp/figma-design-${Date.now()}.png`;
  await writeFile(outputPath, Buffer.from(await img.arrayBuffer()));

  console.log(`  ✓ Exported to ${outputPath}`);
  return { path: outputPath, scale };
}

// ============================================================================
// Step 2: Extract Figma variables/styles as design tokens
// ============================================================================

async function extractFigmaTokens(fileKey) {
  const token = process.env.FIGMA_TOKEN;
  console.log(`[2/5] Extracting Figma variables/styles...`);

  // Get file variables (colors, spacing, etc.)
  const url = `${API}/files/${fileKey}/variables/local`;
  const res = await fetch(url, { headers: { 'X-Figma-Token': token } });

  if (!res.ok) {
    console.warn(`  ⚠ Could not fetch variables (HTTP ${res.status}) — skipping token extraction`);
    return [];
  }

  const json = await res.json();
  const tokens = [];

  // Map Figma variable types to PerfectPixel token kinds
  const typeMap = {
    COLOR: 'color',
    FLOAT: 'spacing', // Figma uses FLOAT for spacing/radius
    STRING: 'font',
  };

  for (const variable of Object.values(json.meta?.variables || {})) {
    // Get the resolved value for the default mode
    const valuesByMode = variable.valuesByMode || {};
    const firstModeId = Object.keys(valuesByMode)[0];
    const value = firstModeId ? valuesByMode[firstModeId] : null;

    if (value && variable.resolvedType) {
      const kind = typeMap[variable.resolvedType] || 'color';

      // Convert color values to hex
      let tokenValue = value;
      if (variable.resolvedType === 'COLOR' && typeof value === 'object') {
        const { r, g, b, a } = value;
        tokenValue = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a || 1})`;
      }

      tokens.push({
        name: variable.name,
        value: String(tokenValue),
        kind,
      });
    }
  }

  console.log(`  ✓ Extracted ${tokens.length} tokens`);
  return tokens;
}

// ============================================================================
// Step 3: Extract node bounding boxes for region annotation
// ============================================================================

async function extractNodeBounds(fileKey, nodeId, scale) {
  const token = process.env.FIGMA_TOKEN;
  console.log(`[3/5] Extracting node bounding boxes...`);

  // Get file nodes with geometry
  const url = `${API}/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&geometry=paths`;
  const res = await fetch(url, { headers: { 'X-Figma-Token': token } });

  if (!res.ok) {
    console.warn(`  ⚠ Could not fetch node bounds (HTTP ${res.status}) — skipping node annotation`);
    return [];
  }

  const json = await res.json();
  const nodes = [];

  // Recursively extract all child nodes with their bounds
  function extractNodes(node, parentX = 0, parentY = 0) {
    const absX = parentX + (node.absoluteBoundingBox?.x || 0);
    const absY = parentY + (node.absoluteBoundingBox?.y || 0);

    // Only include nodes with meaningful dimensions
    if (node.absoluteBoundingBox && node.name) {
      nodes.push({
        name: node.name,
        // IMPORTANT: Divide by scale to convert from design-image space to viewport space
        x: Math.round(absX / scale),
        y: Math.round(absY / scale),
        width: Math.round(node.absoluteBoundingBox.width / scale),
        height: Math.round(node.absoluteBoundingBox.height / scale),
      });
    }

    // Recurse into children
    if (node.children) {
      for (const child of node.children) {
        extractNodes(child, absX, absY);
      }
    }
  }

  const document = json.nodes?.[nodeId]?.document;
  if (document) {
    extractNodes(document);
  }

  console.log(`  ✓ Extracted ${nodes.length} node bounds`);
  return nodes;
}

// ============================================================================
// Step 4: Call PerfectPixel with full designContext
// ============================================================================

async function callPerfectPixel(pageUrl, designImagePath, designContext) {
  console.log(`[4/5] Running PerfectPixel capture_and_diff...`);

  // Option A: Using the core library directly
  const { captureAndDiff } = await import('@mcp-perfectpixel/core');

  const result = await captureAndDiff({
    url: pageUrl,
    designImagePath,
    designContext,
    textRegionThreshold: 0.2, // Filter text anti-aliasing noise
  });

  console.log(`  ✓ Capture complete`);
  console.log(`    Similarity: ${(result.similarity * 100).toFixed(2)}%`);
  console.log(`    Regions: ${result.regions.length}`);
  console.log(`    Duration: ${result.capture.durationMs}ms`);

  return result;
}

// ============================================================================
// Step 5: Interpret results and map regions back to Figma layers
// ============================================================================

function interpretResults(result) {
  console.log(`[5/5] Interpreting results...`);
  console.log('');

  if (result.status === 'match') {
    console.log('✅ Perfect match! No differences detected.');
    return;
  }

  console.log(`⚠️  Found ${result.regions.length} difference(s):\n`);

  for (const region of result.regions) {
    console.log(`Region ${region.id} (${region.severity} severity):`);
    console.log(`  Position: ${region.x},${region.y} (${region.width}x${region.height}px)`);
    console.log(
      `  Pixel diff: ${region.pixelCount} pixels (${(region.coverage * 100).toFixed(1)}% coverage)`,
    );

    // Map to Figma layer
    if (region.figmaNode) {
      console.log(`  Figma layer: ${region.figmaNode}`);
    }

    // Source location
    if (region.source) {
      const rule = region.source.rules[0];
      if (rule?.source) {
        console.log(`  Source: ${rule.source.file}:${rule.source.line}:${rule.source.column}`);
      }

      // Patch suggestions
      if (region.source.patches.length > 0) {
        const patch = region.source.patches[0];
        console.log(`  Fix: ${patch.property} ${patch.current} → ${patch.suggested}`);

        if (patch.figmaToken) {
          console.log(`    (Figma token: ${patch.figmaToken.name} = ${patch.figmaToken.value})`);
        }
      }

      // Notes
      if (region.source.notes.length > 0) {
        console.log(`  Notes:`);
        for (const note of region.source.notes) {
          console.log(`    - ${note}`);
        }
      }
    }

    console.log('');
  }

  // Text noise filter summary
  if (result.textNoiseFilter?.enabled) {
    console.log(`Text noise filter:`);
    console.log(
      `  Dropped ${result.textNoiseFilter.droppedRegions.length} text region(s) as anti-aliasing noise`,
    );
  }

  // Design image hash for determinism verification
  if (result.artifacts.designImageHash) {
    console.log(`\nDesign image hash: ${result.artifacts.designImageHash}`);
    console.log(`(Use this to verify the same design was used across re-captures)`);
  }
}

// ============================================================================
// Main workflow
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const figmaUrl = args[0];
  const pageUrl = args[1];
  const outputOpt = args.indexOf('-o');
  const outputPath = outputOpt !== -1 ? args[outputOpt + 1] : null;

  if (!figmaUrl || !pageUrl) {
    console.error(
      'Usage: FIGMA_TOKEN=<token> node figma-workflow.mjs <figmaUrl> <pageUrl> [-o outputPath]',
    );
    console.error('');
    console.error('Example:');
    console.error('  FIGMA_TOKEN=figd_... node figma-workflow.mjs \\');
    console.error('    "https://www.figma.com/design/FILE_KEY/slug?node-id=1689-7871" \\');
    console.error('    "http://localhost:3000"');
    process.exit(1);
  }

  // Parse Figma URL
  const url = new URL(figmaUrl);
  const fileKey = url.pathname.split('/')[2];
  const nodeId = url.searchParams.get('node-id');

  if (!fileKey || !nodeId) {
    console.error('Could not parse Figma URL — expected format:');
    console.error('  https://www.figma.com/design/<fileKey>/<slug>?node-id=<nodeId>');
    process.exit(1);
  }

  console.log('Figma → PerfectPixel Workflow');
  console.log('==============================\n');

  try {
    // Step 1: Export Figma node
    const { path: designImagePath, scale } = await exportFigmaNode(fileKey, nodeId, 2);

    // Step 2: Extract tokens
    const tokens = await extractFigmaTokens(fileKey);

    // Step 3: Extract node bounds
    const nodes = await extractNodeBounds(fileKey, nodeId, scale);

    // Step 4: Call PerfectPixel
    const designContext = {
      scale,
      tokens: tokens.length > 0 ? tokens : undefined,
      nodes: nodes.length > 0 ? nodes : undefined,
    };

    const result = await callPerfectPixel(pageUrl, designImagePath, designContext);

    // Step 5: Interpret results
    interpretResults(result);

    // Cleanup (optional)
    if (!outputPath) {
      const { unlink } = await import('node:fs/promises');
      await unlink(designImagePath);
      console.log(`\nCleaned up temporary design image: ${designImagePath}`);
    } else {
      const { copyFile } = await import('node:fs/promises');
      await copyFile(designImagePath, outputPath);
      console.log(`\nSaved design image to: ${outputPath}`);
    }
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

main();
