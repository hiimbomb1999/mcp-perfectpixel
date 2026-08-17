export { captureAndDiff } from './capture.js';
export { diffImages, findComponents, mergeComponents } from './diff.js';
export { decodeImage, decodeJpg, decodePng, resizeRgba } from './pixels.js';
export { searchSelectors, GitignoreMatcher, classifyMatch } from './search.js';
export {
  buildPatches,
  cascadeWinner,
  findCulpritProp,
  findDesignTokens,
  inheritanceNotes,
  normalizeColor,
  sampleDesignColor,
} from './patches.js';
export { pickElement, regionSamplePoints } from './trace.js';
export { assertTargetAllowed, classifyTarget, isPrivateNetworkHost } from './security.js';
export {
  assertViewportOk,
  MAX_REGIONS,
  MAX_VIEWPORT_PIXELS,
  MAX_VIEWPORT_SIDE,
  MAX_WAIT_MS,
} from './limits.js';
export {
  decodeMappings,
  decodeSourceMap,
  decodeVLQ,
  extractSourceMappingUrl,
  joinSourcePath,
  mapOffset,
  offsetToLineCol,
  originalPositionFor,
  parseSourceMap,
} from './sourcemap.js';
export { compareSpecificity, selectorKeyOf, specificityOf } from './css.js';
export type { DiffAnalysis } from './diff.js';
export type { MatchContext, TextMatch } from './search.js';
export type { Mode, TargetClass } from './security.js';
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
