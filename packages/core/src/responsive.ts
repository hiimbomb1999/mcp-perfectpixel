/**
 * Responsive design validation - Phase 3
 *
 * Analyzes layout issues across multiple viewports to detect
 * breakpoint-specific problems like overlaps, overflows, and misalignments.
 */
import type { Page, Browser } from 'playwright';
import type { ResponsiveAnalysis, ResponsiveIssue, Viewport } from './types.js';

/**
 * Analyze responsive design issues across multiple viewports.
 */
export async function analyzeResponsive(
  url: string,
  viewports: Viewport[],
  browser: Browser,
): Promise<ResponsiveAnalysis> {
  const issues: ResponsiveIssue[] = [];
  let passingBreakpoints = 0;
  let failingBreakpoints = 0;

  for (const viewport of viewports) {
    const viewportIssues = await analyzeViewport(url, viewport, browser);

    if (viewportIssues.length === 0) {
      passingBreakpoints++;
    } else {
      failingBreakpoints++;
      issues.push(...viewportIssues);
    }
  }

  return {
    issues,
    breakpointCoverage: {
      totalBreakpoints: viewports.length,
      passingBreakpoints,
      failingBreakpoints,
    },
  };
}

/**
 * Analyze a single viewport for responsive issues.
 */
async function analyzeViewport(
  url: string,
  viewport: Viewport,
  browser: Browser,
): Promise<ResponsiveIssue[]> {
  const issues: ResponsiveIssue[] = [];

  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });

  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for fonts to load
    await page.evaluate(() => document.fonts.ready);

    // Check for overflow issues
    const overflowIssues = await checkOverflow(page, viewport);
    issues.push(...overflowIssues);

    // Check for overlap issues
    const overlapIssues = await checkOverlaps(page, viewport);
    issues.push(...overlapIssues);

    // Check for misalignment issues
    const alignmentIssues = await checkAlignment(page, viewport);
    issues.push(...alignmentIssues);

    await page.close();
  } finally {
    await context.close();
  }

  return issues;
}

/**
 * Check for content overflow (horizontal scroll, text overflow).
 */
async function checkOverflow(page: Page, viewport: Viewport): Promise<ResponsiveIssue[]> {
  const issues: ResponsiveIssue[] = [];

  // Check for horizontal overflow
  const overflowData = await page.evaluate(() => {
    const docWidth = document.documentElement.scrollWidth;
    const viewportWidth = window.innerWidth;
    const hasHorizontalOverflow = docWidth > viewportWidth;

    // Find elements that overflow
    const overflowingElements: Array<{
      selector: string;
      rect: { x: number; width: number };
    }> = [];

    if (hasHorizontalOverflow) {
      const allElements = Array.from(document.querySelectorAll('*'));
      for (const el of allElements) {
        const rect = el.getBoundingClientRect();
        if (rect.right > viewportWidth) {
          const selector = getElementSelector(el as Element);
          overflowingElements.push({
            selector,
            rect: { x: rect.x, width: rect.width },
          });
        }
      }
    }

    // Check for text overflow
    const textOverflowElements: Array<{
      selector: string;
      text: string;
    }> = [];

    const elementsWithText = Array.from(
      document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, span, a, button, label'),
    );
    for (const el of elementsWithText) {
      const element = el as HTMLElement;
      const style = getComputedStyle(element);
      if (
        style.overflow === 'hidden' &&
        (style.textOverflow === 'ellipsis' || style.whiteSpace === 'nowrap')
      ) {
        if (element.scrollWidth > element.clientWidth) {
          const selector = getElementSelector(element);
          textOverflowElements.push({
            selector,
            text: element.textContent?.trim().slice(0, 50) || '',
          });
        }
      }
    }

    return {
      hasHorizontalOverflow,
      docWidth,
      viewportWidth,
      overflowingElements,
      textOverflowElements,
    };
  });

  // Report horizontal overflow
  if (overflowData.hasHorizontalOverflow) {
    const overflow = overflowData.docWidth - overflowData.viewportWidth;

    if (overflowData.overflowingElements.length > 0) {
      // Report specific elements causing overflow
      for (const el of overflowData.overflowingElements.slice(0, 3)) {
        issues.push({
          viewport,
          type: 'overflow',
          element: el.selector,
          description: `Element overflows viewport by ${Math.round(overflow)}px`,
          suggestion: `Add max-width: 100% or reduce width. Element extends to ${Math.round(el.rect.x + el.rect.width)}px but viewport is ${viewport.width}px.`,
        });
      }
    } else {
      issues.push({
        viewport,
        type: 'overflow',
        element: 'body',
        description: `Page has horizontal overflow of ${Math.round(overflow)}px`,
        suggestion: `Check for fixed-width elements or add overflow-x: hidden to body.`,
      });
    }
  }

  // Report text overflow
  for (const el of overflowData.textOverflowElements.slice(0, 3)) {
    issues.push({
      viewport,
      type: 'overflow',
      element: el.selector,
      description: `Text is truncated: "${el.text}..."`,
      suggestion: `Consider reducing font-size, using smaller text, or allowing text to wrap.`,
    });
  }

  return issues;
}

/**
 * Check for overlapping elements.
 */
async function checkOverlaps(page: Page, viewport: Viewport): Promise<ResponsiveIssue[]> {
  const issues: ResponsiveIssue[] = [];

  const overlapData = await page.evaluate(() => {
    const overlaps: Array<{
      selector1: string;
      selector2: string;
      rect1: { x: number; y: number; width: number; height: number };
      rect2: { x: number; y: number; width: number; height: number };
    }> = [];

    // Get all visible elements with significant size
    const elements: Array<{
      el: Element;
      rect: DOMRect;
      selector: string;
    }> = [];

    const allElements = Array.from(
      document.querySelectorAll(
        'div, section, article, header, footer, nav, main, button, a, img, h1, h2, h3, h4, h5, h6, p',
      ),
    );

    for (const el of allElements) {
      const rect = el.getBoundingClientRect();
      // Only consider elements with significant size
      if (rect.width > 20 && rect.height > 20) {
        elements.push({
          el,
          rect,
          selector: getElementSelector(el),
        });
      }
    }

    // Check for overlaps (limit to first 50 elements for performance)
    const limit = Math.min(elements.length, 50);
    for (let i = 0; i < limit; i++) {
      for (let j = i + 1; j < limit; j++) {
        const a = elements[i]!;
        const b = elements[j]!;

        // Check if rectangles overlap
        const overlap =
          a.rect.left < b.rect.right &&
          a.rect.right > b.rect.left &&
          a.rect.top < b.rect.bottom &&
          a.rect.bottom > b.rect.top;

        if (overlap) {
          // Calculate overlap area
          const x1 = Math.max(a.rect.left, b.rect.left);
          const y1 = Math.max(a.rect.top, b.rect.top);
          const x2 = Math.min(a.rect.right, b.rect.right);
          const y2 = Math.min(a.rect.bottom, b.rect.bottom);
          const overlapArea = (x2 - x1) * (y2 - y1);
          const minArea = Math.min(a.rect.width * a.rect.height, b.rect.width * b.rect.height);

          // Only report if overlap is significant (>20% of smaller element)
          if (overlapArea > minArea * 0.2) {
            overlaps.push({
              selector1: a.selector,
              selector2: b.selector,
              rect1: {
                x: a.rect.x,
                y: a.rect.y,
                width: a.rect.width,
                height: a.rect.height,
              },
              rect2: {
                x: b.rect.x,
                y: b.rect.y,
                width: b.rect.width,
                height: b.rect.height,
              },
            });
          }
        }
      }
    }

    return overlaps.slice(0, 5); // Limit to 5 overlaps
  });

  // Report overlaps
  for (const overlap of overlapData) {
    issues.push({
      viewport,
      type: 'overlap',
      element: overlap.selector1,
      description: `Element overlaps with ${overlap.selector2}`,
      suggestion: `Check positioning, z-index, or layout. Consider using flexbox or grid to prevent overlaps.`,
    });
  }

  return issues;
}

/**
 * Check for alignment issues.
 */
async function checkAlignment(page: Page, viewport: Viewport): Promise<ResponsiveIssue[]> {
  const issues: ResponsiveIssue[] = [];

  const alignmentData = await page.evaluate(() => {
    const misalignments: Array<{
      selector: string;
      expected: string;
      actual: string;
    }> = [];

    // Check for center alignment issues
    const centeredElements = Array.from(
      document.querySelectorAll(
        '[class*="center"], [class*="Center"], [style*="text-align: center"]',
      ),
    );

    for (const el of centeredElements) {
      const rect = el.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const elementCenter = rect.x + rect.width / 2;
      const viewportCenter = viewportWidth / 2;
      const offset = Math.abs(elementCenter - viewportCenter);

      // If element should be centered but is off by more than 5px
      if (offset > 5 && rect.width < viewportWidth * 0.9) {
        misalignments.push({
          selector: getElementSelector(el),
          expected: 'centered',
          actual: `offset by ${Math.round(offset)}px`,
        });
      }
    }

    // Check for left alignment issues in containers
    const containers = Array.from(
      document.querySelectorAll('[class*="container"], [class*="wrapper"], main, section'),
    );

    for (const container of containers) {
      const children = Array.from(container.children);

      if (children.length > 1) {
        // Check if children have consistent left alignment
        const leftPositions: number[] = [];
        for (const child of children) {
          const rect = child.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            leftPositions.push(rect.x);
          }
        }

        if (leftPositions.length > 1) {
          const minLeft = Math.min(...leftPositions);
          const maxLeft = Math.max(...leftPositions);
          const variation = maxLeft - minLeft;

          // If children have varying left positions (more than 10px variation)
          if (variation > 10) {
            misalignments.push({
              selector: getElementSelector(container),
              expected: 'consistent left alignment',
              actual: `${Math.round(variation)}px variation in child positions`,
            });
          }
        }
      }
    }

    return misalignments.slice(0, 5); // Limit to 5 misalignments
  });

  // Report misalignments
  for (const misalignment of alignmentData) {
    issues.push({
      viewport,
      type: 'misalignment',
      element: misalignment.selector,
      description: `Element ${misalignment.actual}, expected ${misalignment.expected}`,
      suggestion: `Check margin, padding, or alignment properties. Consider using flexbox or grid for consistent alignment.`,
    });
  }

  return issues;
}

/**
 * Generate a CSS selector for an element.
 */
function getElementSelector(el: Element): string {
  if (el.id) {
    return `#${el.id}`;
  }

  const classes = Array.from(el.classList);
  if (classes.length > 0) {
    return `${el.tagName.toLowerCase()}.${classes.slice(0, 2).join('.')}`;
  }

  return el.tagName.toLowerCase();
}
