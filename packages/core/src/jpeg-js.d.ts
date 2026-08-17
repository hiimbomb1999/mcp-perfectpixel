declare module 'jpeg-js' {
  export interface JpegImageData {
    width: number;
    height: number;
    data: Uint8Array;
  }

  export interface DecodeOptions {
    useTArray?: boolean;
    colorTransform?: boolean;
    formatAsRGBA?: boolean;
    tolerantDecoding?: boolean;
    maxResolutionInMP?: number;
    maxMemoryUsageInMB?: number;
  }

  export function decode(jpegData: Buffer | Uint8Array, options?: DecodeOptions): JpegImageData;
}
