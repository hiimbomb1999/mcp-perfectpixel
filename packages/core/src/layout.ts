/**
 * Advanced layout analysis - Phase 2
 *
 * Analyzes spacing, typography, and alignment issues between design and code.
 * Works at the compiled-CSS layer, framework-agnostic.
 */
import type { Page } from 'playwright';
import type {
  DesignContext,
  DiffRegion,
  FigmaNode,
  LayoutAnalysis,
  SpacingIssue,
  TextRegionInfo,
  TypographyIssue,
} from './types.js';

/** Typography properties to analyze. */
const TYPOGRAPHY_PROPS = [
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
] as const;

/** Spacing properties to analyze. */
const SPACING_PROPS = [
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'gap',
] as const;

/**
 * Analyze layout issues (spacing, typography, alignment) for diff regions.
 */
export async function analyzeLayout(
  page: Page,
  regions: DiffRegion[],
  designContext?: DesignContext,
): Promise<LayoutAnalysis> {
  const spacingIssues: SpacingIssue[] = [];
  const typographyIssues: TypographyIssue[] = [];
  const textRegions: TextRegionInfo[] = [];

  if (regions.length === 0) {
    return {
      spacing: { issues: [] },
      typography: { issues: [], textRegions: [] },
    };
  }

  // Collect element info and computed styles for all regions
  const points = regions.map((r) => ({
    x: r.x + r.width / 2,
    y: r.y + r.height / 2,
    regionId: r.id,
  }));

  const elementData = await page.evaluate((pts: typeof points) => {
    return pts.map((p) => {
      const el = document.elementFromPoint(p.x, p.y);
      if (!el || el.nodeType !== 1) return null;

      const element = el as Element;
      const cs = getComputedStyle(element);

      // Extract typography styles
      const typography: Record<string, string> = {};
      for (const prop of [
        'font-family',
        'font-size',
        'font-weight',
        'line-height',
        'letter-spacing',
      ]) {
        typography[prop] = cs.getPropertyValue(prop);
      }

      // Extract spacing styles
      const spacing: Record<string, string> = {};
      for (const prop of [
        'margin-top',
        'margin-right',
        'margin-bottom',
        'margin-left',
        'padding-top',
        'padding-right',
        'padding-bottom',
        'padding-left',
        'gap',
      ]) {
        spacing[prop] = cs.getPropertyValue(prop);
      }

      // Extract text content
      const text = element.textContent?.trim() || '';

      // Extract element info
      const rect = element.getBoundingClientRect();

      return {
        regionId: p.regionId,
        tag: element.tagName.toLowerCase(),
        id: element.id || null,
        classes: Array.from(element.classList),
        text,
        typography,
        spacing,
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
      };
    });
  }, points);

  // Analyze each region
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i]!;
    const data = elementData[i];

    if (!data) continue;

    const selector = data.id
      ? `#${data.id}`
      : data.classes.length > 0
        ? `${data.tag}.${data.classes.join('.')}`
        : data.tag;

    const figmaNode = findOverlappingFigmaNode(region, designContext?.nodes);

    // Analyze typography
    if (data.text && data.text.length > 0) {
      const textRegion: TextRegionInfo = {
        id: region.id,
        text: data.text.slice(0, 100), // Limit text length
        computedStyles: data.typography,
        designStyles: {}, // Will be populated from Figma if available
      };
      textRegions.push(textRegion);

      // Check for typography issues if we have Figma design styles
      if (figmaNode && designContext?.tokens) {
        const issues = analyzeTypographyForRegion(selector, data.typography, designContext.tokens);
        typographyIssues.push(...issues);
      }
    }

    // Analyze spacing
    const spacingIssuesForRegion = analyzeSpacingForRegion(
      selector,
      data.spacing,
      data.rect,
      region,
      figmaNode,
      designContext?.nodes,
    );
    spacingIssues.push(...spacingIssuesForRegion);
  }

  return {
    spacing: { issues: spacingIssues },
    typography: { issues: typographyIssues, textRegions },
  };
}

/**
 * Find the Figma node that overlaps with a diff region.
 */
function findOverlappingFigmaNode(region: DiffRegion, nodes?: FigmaNode[]): FigmaNode | null {
  if (!nodes || nodes.length === 0) return null;

  let bestNode: FigmaNode | null = null;
  let bestOverlap = 0;

  for (const node of nodes) {
    const overlap = calculateOverlap(region, node);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestNode = node;
    }
  }

  return bestOverlap > 0.5 ? bestNode : null; // At least 50% overlap
}

/**
 * Calculate overlap ratio between a region and a Figma node.
 */
function calculateOverlap(
  region: { x: number; y: number; width: number; height: number },
  node: { x: number; y: number; width: number; height: number },
): number {
  const x1 = Math.max(region.x, node.x);
  const y1 = Math.max(region.y, node.y);
  const x2 = Math.min(region.x + region.width, node.x + node.width);
  const y2 = Math.min(region.y + region.height, node.y + node.height);

  if (x2 <= x1 || y2 <= y1) return 0;

  const intersection = (x2 - x1) * (y2 - y1);
  const regionArea = region.width * region.height;

  return intersection / regionArea;
}

/**
 * Analyze typography issues for a region.
 */
function analyzeTypographyForRegion(
  selector: string,
  computed: Record<string, string>,
  figmaTokens: Array<{ name: string; value: string; kind: string }>,
): TypographyIssue[] {
  const issues: TypographyIssue[] = [];

  // Check each typography property
  for (const prop of TYPOGRAPHY_PROPS) {
    const actualValue = computed[prop];
    if (!actualValue) continue;

    // Try to find matching Figma token
    const matchingToken = figmaTokens.find(
      (t) => t.kind === 'font' && normalizeValue(t.value) === normalizeValue(actualValue),
    );

    // If no matching token found, it might be an issue
    if (!matchingToken && isTypographySignificant(prop, actualValue)) {
      issues.push({
        element: selector,
        property: prop,
        expected: 'Design token',
        actual: actualValue,
        suggestion: `Consider using a design token for ${prop}`,
      });
    }
  }

  return issues;
}

/**
 * Analyze spacing issues for a region.
 */
function analyzeSpacingForRegion(
  selector: string,
  computed: Record<string, string>,
  rect: { x: number; y: number; width: number; height: number },
  region: DiffRegion,
  figmaNode: FigmaNode | null,
  _nodes?: FigmaNode[],
): SpacingIssue[] {
  const issues: SpacingIssue[] = [];

  // If we have a Figma node, compare positions
  if (figmaNode) {
    // Check horizontal alignment
    const expectedX = figmaNode.x;
    const actualX = rect.x;
    const deltaX = Math.abs(expectedX - actualX);

    if (deltaX > 2) {
      // More than 2px difference
      issues.push({
        type: 'alignment',
        property: 'horizontal-position',
        expected: `${expectedX}px`,
        actual: `${actualX}px`,
        delta: deltaX,
        element: selector,
        figmaNode: figmaNode.name,
        suggestion: `Element is ${deltaX}px off from design position. Check margin or padding.`,
      });
    }

    // Check vertical alignment
    const expectedY = figmaNode.y;
    const actualY = rect.y;
    const deltaY = Math.abs(expectedY - actualY);

    if (deltaY > 2) {
      issues.push({
        type: 'alignment',
        property: 'vertical-position',
        expected: `${expectedY}px`,
        actual: `${actualY}px`,
        delta: deltaY,
        element: selector,
        figmaNode: figmaNode.name,
        suggestion: `Element is ${deltaY}px off from design position. Check margin or padding.`,
      });
    }

    // Check dimensions
    const expectedWidth = figmaNode.width;
    const actualWidth = rect.width;
    const deltaWidth = Math.abs(expectedWidth - actualWidth);

    if (deltaWidth > 2) {
      issues.push({
        type: 'padding',
        property: 'width',
        expected: `${expectedWidth}px`,
        actual: `${actualWidth}px`,
        delta: deltaWidth,
        element: selector,
        figmaNode: figmaNode.name,
        suggestion: `Width differs by ${deltaWidth}px. Check padding or box-sizing.`,
      });
    }

    const expectedHeight = figmaNode.height;
    const actualHeight = rect.height;
    const deltaHeight = Math.abs(expectedHeight - actualHeight);

    if (deltaHeight > 2) {
      issues.push({
        type: 'padding',
        property: 'height',
        expected: `${expectedHeight}px`,
        actual: `${actualHeight}px`,
        delta: deltaHeight,
        element: selector,
        figmaNode: figmaNode.name,
        suggestion: `Height differs by ${deltaHeight}px. Check padding, line-height, or box-sizing.`,
      });
    }
  }

  // Check for unusual spacing values
  for (const prop of SPACING_PROPS) {
    const value = computed[prop];
    if (!value) continue;

    const pxValue = parsePixelValue(value);
    if (pxValue !== null && isUnusualSpacing(prop, pxValue)) {
      issues.push({
        type: prop.startsWith('margin') ? 'margin' : prop.startsWith('padding') ? 'padding' : 'gap',
        property: prop,
        expected: 'Design token',
        actual: value,
        delta: 0,
        element: selector,
        figmaNode: figmaNode?.name,
        suggestion: `Unusual ${prop} value. Consider using a spacing token.`,
      });
    }
  }

  return issues;
}

/**
 * Check if a typography value is significant enough to report.
 */
function isTypographySignificant(prop: string, value: string): boolean {
  // Font size differences are always significant
  if (prop === 'font-size') {
    const px = parsePixelValue(value);
    return px !== null && px > 0;
  }

  // Font weight differences are significant
  if (prop === 'font-weight') {
    return ['100', '200', '300', '400', '500', '600', '700', '800', '900'].includes(value);
  }

  // Line height differences are significant
  if (prop === 'line-height') {
    const px = parsePixelValue(value);
    const ratio = parseFloat(value);
    return (px !== null && px > 0) || (!isNaN(ratio) && ratio > 0);
  }

  return false;
}

/**
 * Check if a spacing value is unusual (not a common token value).
 */
function isUnusualSpacing(prop: string, pxValue: number): boolean {
  // Common spacing tokens: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96
  const commonValues = [0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96];

  // Check if value is close to a common value (within 1px)
  const isCommon = commonValues.some((v) => Math.abs(v - pxValue) <= 1);

  return !isCommon && pxValue > 0;
}

/**
 * Parse a CSS value to pixels.
 */
function parsePixelValue(value: string): number | null {
  const match = value.match(/^(-?\d+(?:\.\d+)?)px$/);
  return match && match[1] ? parseFloat(match[1]) : null;
}

/**
 * Normalize a CSS value for comparison.
 */
function normalizeValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}
