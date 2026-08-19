# Figma MCP Integration Audit

## Executive Summary

PerfectPixel v0.1.3 đã được thiết kế để hoạt động tốt với Figma MCP, nhưng **chưa tối ưu hoàn toàn**. Có 3 gaps chính cần address để đạt được seamless integration.

## Current Integration Status

### ✓ Working Well

#### 1. Design Context Integration

```typescript
designContext: {
  scale: 2,              // Handle 2x/3x DPI exports
  tokens: [...],         // Figma tokens as ground truth
  nodes: [...]           // Figma layer bounding boxes
}
```

**Status:** ✓ Fully implemented  
**Test Coverage:** Partial (unit tests exist, no e2e Figma workflow test)

#### 2. Token Matching

- Figma tokens win patch suggestions (`figmaToken` field)
- Repo tokens still reported alongside (`token` field)
- Color normalization handles hex, rgb, hsl

**Status:** ✓ Working correctly  
**Example:**

```json
{
  "suggested": "var(--color-success)",
  "figmaToken": { "name": "Success/500", "value": "#16a34a", "kind": "color" },
  "token": { "name": "--color-success", "reference": "var(--color-success)", ... }
}
```

#### 3. Node Annotation

- `figmaNode` field on each region
- Intersection-over-region-area matching
- Ties go to tighter (smaller) node

**Status:** ✓ Working correctly  
**Code:** `trace.ts:figmaNodeName()`

#### 4. Text Noise Filter

- `textRegionThreshold` parameter
- Text-named Figma nodes (`text|label|title|price|desc|heading|body`) help identify text regions
- Dropped regions reported in `textNoiseFilter.droppedRegions`

**Status:** ✓ Working correctly

#### 5. Standalone Export

- `examples/figma-export.mjs` script
- Supports Figma URL parsing, scale, format options
- Uses Figma REST API with personal access token

**Status:** ✓ Working correctly

---

## Critical Gaps

### Gap 1: No Validation for Figma Data Format

**Problem:**  
`designContext` accepts any data without validation. If Figma MCP sends malformed data (wrong coordinate system, missing fields, invalid scale), PerfectPixel silently produces wrong results.

**Impact:**

- Wrong viewport calculation if `scale` is incorrect
- Misaligned regions if `nodes` coordinates are in wrong space
- Token matching fails silently if `tokens` format is wrong

**Example:**

```typescript
// Figma MCP sends nodes in design-image space (e.g., 3840x3344 for @2x)
// But PerfectPixel expects viewport space (1920x1672)
// Result: regions don't align with Figma layers
designContext: {
  scale: 2,
  nodes: [{ name: "Button", x: 120, y: 260, width: 240, height: 72 }]
  // ↑ These are @2x coordinates, but should be divided by scale
}
```

**Recommendation:**  
Add validation layer:

```typescript
function validateDesignContext(ctx: DesignContext, designWidth: number, designHeight: number) {
  if (ctx.scale && (ctx.scale < 1 || ctx.scale > 3)) {
    throw new Error(`Invalid scale ${ctx.scale} — expected 1, 2, or 3`);
  }

  if (ctx.nodes) {
    for (const node of ctx.nodes) {
      if (node.x < 0 || node.y < 0 || node.width <= 0 || node.height <= 0) {
        throw new Error(`Invalid node "${node.name}" — negative dimensions`);
      }
      // Warn if nodes seem to be in design-image space instead of viewport space
      if (ctx.scale && node.x > designWidth / ctx.scale) {
        console.warn(
          `Node "${node.name}" x=${node.x} exceeds viewport width ${designWidth / ctx.scale} — did you forget to divide by scale?`,
        );
      }
    }
  }
}
```

**Priority:** 🔴 High (causes silent failures)

---

### Gap 2: No End-to-End Figma Workflow Example

**Problem:**  
README mentions Figma MCP integration but doesn't provide a complete workflow example showing:

1. How to call Figma MCP to get export URL
2. How to extract tokens and nodes
3. How to pass them to PerfectPixel
4. How to interpret the results

**Impact:**  
Users have to guess the integration pattern. Common mistakes:

- Forgetting to pass `scale`
- Not extracting tokens from Figma
- Misunderstanding coordinate systems

**Recommendation:**  
Add `examples/figma-workflow.mjs` demonstrating complete flow:

```javascript
// 1. Call Figma MCP to export node
const figmaExport = await figmaMCP.getImage({
  fileKey: 'FILE_KEY',
  nodeId: '1689-7871',
  scale: 2,
});

// 2. Extract tokens from Figma variables
const figmaTokens = await figmaMCP.getVariables({
  fileKey: 'FILE_KEY',
});

// 3. Extract node bounding boxes
const figmaNodes = await figmaMCP.getNodeBounds({
  fileKey: 'FILE_KEY',
  nodeId: '1689-7871',
});

// 4. Call PerfectPixel with full context
const result = await perfectpixel.captureAndDiff({
  url: 'http://localhost:3000',
  designImagePath: figmaExport.path,
  designContext: {
    scale: 2,
    tokens: figmaTokens.map((t) => ({
      name: t.name,
      value: t.value,
      kind: t.type,
    })),
    nodes: figmaNodes.map((n) => ({
      name: n.name,
      x: n.x / 2, // Convert to viewport space
      y: n.y / 2,
      width: n.width / 2,
      height: n.height / 2,
    })),
  },
});

// 5. Interpret results
console.log(`Similarity: ${result.similarity}`);
for (const region of result.regions) {
  console.log(`Region ${region.id}:`);
  console.log(`  Figma layer: ${region.figmaNode}`);
  console.log(
    `  Source: ${region.source?.rules[0]?.source?.file}:${region.source?.rules[0]?.source?.line}`,
  );
  console.log(
    `  Patch: ${region.source?.patches[0]?.property} ${region.source?.patches[0]?.current} → ${region.source?.patches[0]?.suggested}`,
  );
}
```

**Priority:** 🟡 Medium (improves UX, not blocking)

---

### Gap 3: No Test Coverage for Figma Integration Scenarios

**Problem:**  
No e2e tests verify:

- `designContext.scale` correctly adjusts viewport
- `designContext.tokens` win patch suggestions
- `designContext.nodes` correctly annotate regions
- `textRegionThreshold` drops text regions with Figma node names

**Impact:**  
Regressions could break Figma integration without detection.

**Recommendation:**  
Add `packages/server/test/figma-integration.e2e.test.ts`:

```typescript
describe('Figma integration', () => {
  it('adjusts viewport when scale=2', async () => {
    // Design image: 1600x1200 (2x)
    // Expected viewport: 800x600 (1x)
    const result = await callCapture(url, {
      designImagePath: design2x,
      designContext: { scale: 2 },
    });
    expect(result.capture.viewport.width).toBe(800);
    expect(result.capture.viewport.height).toBe(600);
  });

  it('Figma tokens win patch suggestions', async () => {
    const result = await callCapture(url, {
      designContext: {
        tokens: [{ name: 'Primary/500', value: '#3b82f6', kind: 'color' }],
      },
    });
    const patch = result.regions[0].source.patches[0];
    expect(patch.figmaToken.name).toBe('Primary/500');
    expect(patch.suggested).toBe('Primary/500');
  });

  it('annotates regions with Figma node names', async () => {
    const result = await callCapture(url, {
      designContext: {
        nodes: [{ name: 'Button/Primary', x: 100, y: 200, width: 120, height: 40 }],
      },
    });
    expect(result.regions[0].figmaNode).toBe('Button/Primary');
  });

  it('drops text regions with Figma text node names', async () => {
    const result = await callCapture(url, {
      textRegionThreshold: 0.2,
      designContext: {
        nodes: [{ name: 'Text/Heading', x: 50, y: 100, width: 200, height: 30 }],
      },
    });
    expect(result.textNoiseFilter.droppedRegions.length).toBeGreaterThan(0);
  });
});
```

**Priority:** 🟡 Medium (prevents regressions)

---

## Minor Gaps

### Gap 4: No Caching for Figma Exports

**Problem:**  
Each `capture_and_diff` call re-downloads the design image. For iterative workflows (fix → re-capture → fix → re-capture), this is slow.

**Impact:**  
Slower iteration cycles.

**Recommendation:**  
Add design image caching:

```typescript
const designCache = new Map<string, { hash: string; image: RgbaImage }>();

async function decodeImageWithCache(path: string, mode: Mode) {
  const hash = await computeFileHash(path);
  const cached = designCache.get(path);
  if (cached && cached.hash === hash) {
    return cached.image;
  }
  const image = await decodeImage(path, mode);
  designCache.set(path, { hash, image });
  return image;
}
```

**Priority:** 🟢 Low (performance optimization)

---

### Gap 5: No Warning for Coordinate System Mismatch

**Problem:**  
If user passes `nodes` in design-image space (e.g., 3840x3344) but forgets to set `scale: 2`, regions won't align with Figma layers. No warning is shown.

**Impact:**  
Confusing results — `figmaNode` annotations are wrong.

**Recommendation:**  
Add heuristic detection:

```typescript
if (designContext?.nodes && !designContext.scale) {
  const maxNodeX = Math.max(...designContext.nodes.map((n) => n.x + n.width));
  const maxNodeY = Math.max(...designContext.nodes.map((n) => n.y + n.height));

  // If nodes extend beyond viewport, they might be in design-image space
  if (maxNodeX > design.width * 1.5 || maxNodeY > design.height * 1.5) {
    traceWarnings.push(
      `Figma nodes extend beyond viewport (max x=${maxNodeX}, y=${maxNodeY}) — ` +
        `did you forget to set designContext.scale?`,
    );
  }
}
```

**Priority:** 🟢 Low (UX improvement)

---

## Integration Checklist

Use this checklist when integrating PerfectPixel with Figma MCP:

- [ ] Export Figma node at correct scale (1x for web, 2x for high-DPI)
- [ ] Pass `designContext.scale` matching the export scale
- [ ] Extract Figma variables/styles as `designContext.tokens`
- [ ] Extract node bounding boxes as `designContext.nodes`
- [ ] **Divide node coordinates by scale** if they're in design-image space
- [ ] Set `textRegionThreshold` (e.g., 0.2) to filter text anti-aliasing noise
- [ ] Verify `designImageHash` matches across re-captures (determinism check)
- [ ] Check `textNoiseFilter.droppedRegions` to see which text regions were dropped
- [ ] Use `figmaNode` annotations to map regions back to Figma layers
- [ ] Use `figmaToken` in patch suggestions to maintain design system consistency

---

## Recommendations

### Immediate (Before Next Release)

1. **Add validation for `designContext`** (Gap 1)
   - Prevents silent failures
   - Low implementation cost
   - High impact

### Short-term (Next 1-2 Weeks)

2. **Add e2e Figma integration tests** (Gap 3)
   - Prevents regressions
   - Documents expected behavior

3. **Add complete workflow example** (Gap 2)
   - Improves UX
   - Reduces support questions

### Long-term (Backlog)

4. **Add design image caching** (Gap 4)
   - Performance optimization
   - Nice-to-have

5. **Add coordinate system mismatch warning** (Gap 5)
   - UX improvement
   - Low priority

---

## Conclusion

PerfectPixel v0.1.3 **works well** with Figma MCP for basic use cases, but **is not yet optimized** for production workflows. The main gaps are:

1. **No validation** — can cause silent failures
2. **No complete example** — users have to guess the integration pattern
3. **No test coverage** — regressions could break integration

**Recommendation:** Address Gap 1 (validation) before promoting Figma integration as "production-ready". Gaps 2-3 can be addressed in parallel.

**Overall Score:** 7/10 — Good foundation, needs polish for production use.
