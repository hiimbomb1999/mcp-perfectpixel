export { captureAndDiff } from './capture.js';
export { diffImages, findComponents, mergeComponents } from './diff.js';
export { decodeImage, decodeJpg, decodePng, resizeRgba } from './pixels.js';
export { searchSelectors, GitignoreMatcher } from './search.js';
export { buildPatches, findDesignTokens, normalizeColor, sampleDesignColor } from './patches.js';
export {
  decodeMappings,
  decodeVLQ,
  extractSourceMappingUrl,
  mapOffset,
  offsetToLineCol,
  originalPositionFor,
  parseSourceMap,
} from './sourcemap.js';
export type { DiffAnalysis } from './diff.js';
export type { TextMatch } from './search.js';
export type {
  CaptureInfo,
  CaptureOptions,
  Confidence,
  DesignToken,
  DiffArtifacts,
  DiffRegion,
  DiffResult,
  ElementEvidence,
  PatchSuggestion,
  RegionSource,
  RgbaImage,
  RuleEvidence,
  Severity,
  SourceLocation,
  TokenKind,
  Viewport,
} from './types.js';
