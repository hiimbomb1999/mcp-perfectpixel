declare module 'ignore' {
  export interface Ignore {
    add(patterns: string | string[]): Ignore;
    ignores(pathname: string): boolean;
    test(pathname: string): { ignored: boolean; unignored: boolean };
  }
  export interface IgnoreOptions {
    ignorecase?: boolean;
    allowRelativePaths?: boolean;
  }
  export default function ignore(options?: IgnoreOptions): Ignore;
}
