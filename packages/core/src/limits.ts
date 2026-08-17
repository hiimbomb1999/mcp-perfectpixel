/**
 * Resource limits (improvement #5) — bounds that keep capture + tracing safe
 * on untrusted input and pathological pages/repos.
 */

/** Max viewport area in pixels (4096x4096). */
export const MAX_VIEWPORT_PIXELS = 16_777_216;
/** Max viewport side in CSS pixels. */
export const MAX_VIEWPORT_SIDE = 8192;
/** Max design image file size (local or downloaded). */
export const MAX_DESIGN_FILE_BYTES = 50 * 1024 * 1024;
/** Max extra settle time (waitMs) in ms. */
export const MAX_WAIT_MS = 60_000;
/** Max diff regions returned per capture. */
export const MAX_REGIONS = 50;
/** Fetch timeout for remote images / stylesheets / source maps, in ms. */
export const FETCH_TIMEOUT_MS = 15_000;

/** Throws when a viewport exceeds the limits. */
export function assertViewportOk(width: number, height: number, label = 'viewport'): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid ${label} dimensions: ${width}x${height}`);
  }
  if (width > MAX_VIEWPORT_SIDE || height > MAX_VIEWPORT_SIDE) {
    throw new Error(
      `${label} ${width}x${height} exceeds the maximum side of ${MAX_VIEWPORT_SIDE}px`,
    );
  }
  if (width * height > MAX_VIEWPORT_PIXELS) {
    throw new Error(
      `${label} ${width}x${height} exceeds the maximum of ${MAX_VIEWPORT_PIXELS} pixels`,
    );
  }
}
