export { captureAndDiff, captureAndDiffMultiViewport, deriveViewport } from './capture.js';
export {
  diffImages,
  dropTextNoise,
  findComponents,
  isTextLikeRegion,
  mergeComponents,
  regionDiffersAt,
} from './diff.js';
export { decodeImage, decodeJpg, decodePng, resizeRgba } from './pixels.js';
export {
  searchSelectors,
  GitignoreMatcher,
  classifyMatch,
  detectPlatform,
  matchesPlatformGlobs,
} from './search.js';
export {
  buildPatches,
  cascadeWinner,
  findCulpritProp,
  findDesignTokens,
  inheritanceNotes,
  normalizeColor,
  sampleDesignColor,
} from './patches.js';
export {
  analyzeDimensionDiff,
  figmaNodeName,
  pickElement,
  regionSamplePoints,
  responsiveNotes,
  trimComputedStyle,
} from './trace.js';
export { FileTextCache, sharedFileTextCache } from './fileread.js';
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
export type { Box2, DiffAnalysis } from './diff.js';
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
  DimensionAnalysis,
  ElementEvidence,
  MultiViewportResult,
  PatchSuggestion,
  RegionSource,
  RgbaImage,
  RuleEvidence,
  Severity,
  SourceLocation,
  TextNoiseFilter,
  TokenKind,
  Viewport,
} from './types.js';
