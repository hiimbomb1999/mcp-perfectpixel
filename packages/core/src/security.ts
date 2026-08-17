/**
 * Trust boundary (improvement #9).
 *
 * `mode: 'local'` (default) is for a developer's own machine: file:// URLs and
 * local paths are allowed — the whole point is diffing local dev servers and
 * local design files.
 *
 * `mode: 'hosted'` is for running the server against untrusted input: file://
 * access is refused, and every http(s) target (page, design image, stylesheet,
 * source map) must not resolve to a private-network host (SSRF protection).
 * repoRoot must be provided explicitly in hosted mode (never default to the
 * server's cwd).
 */

export type Mode = 'local' | 'hosted';

const PRIVATE_HOST =
  /^(0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|\[::1\]|::1|localhost)$/i;
const LOCAL_TLD = /\.local$/i;

export function isPrivateNetworkHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return PRIVATE_HOST.test(host) || LOCAL_TLD.test(host) || host.startsWith('169.254.');
}

export interface TargetClass {
  /** 'http', 'https', 'file', or '' when the input isn't a URL. */
  protocol: string;
  privateNetwork: boolean;
}

export function classifyTarget(target: string): TargetClass {
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) {
    return { protocol: '', privateNetwork: false }; // local filesystem path
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { protocol: '', privateNetwork: false };
  }
  return {
    protocol: url.protocol.toLowerCase().replace(/:$/, ''),
    privateNetwork: isPrivateNetworkHost(url.hostname),
  };
}

/** Throws when `target` is not allowed in `mode`. `kind` names the target. */
export function assertTargetAllowed(target: string, mode: Mode, kind: string): void {
  const { protocol, privateNetwork } = classifyTarget(target);
  if (protocol === '') {
    // Local filesystem path.
    if (mode === 'hosted') {
      throw new Error(`${kind} uses a local filesystem path, which is only allowed in local mode`);
    }
    return;
  }
  if (protocol !== 'http' && protocol !== 'https' && protocol !== 'file') {
    throw new Error(
      `${kind} uses unsupported protocol "${protocol}" (allowed: http, https${
        mode === 'local' ? ', file' : ''
      })`,
    );
  }
  if (protocol === 'file' && mode === 'hosted') {
    throw new Error(`${kind} uses file:// which is only allowed in local mode`);
  }
  if (mode === 'hosted' && privateNetwork) {
    throw new Error(
      `${kind} targets a private-network host (${target}), which is blocked in hosted mode`,
    );
  }
}
