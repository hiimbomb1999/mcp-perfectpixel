import { describe, expect, it } from 'vitest';
import { assertTargetAllowed, classifyTarget, isPrivateNetworkHost } from '@mcp-perfectpixel/core';

describe('classifyTarget / isPrivateNetworkHost', () => {
  it('detects private-network hosts', () => {
    for (const host of [
      'localhost',
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '::1',
      '[::1]',
      'intranet.local',
      '169.254.1.1',
    ]) {
      expect(isPrivateNetworkHost(host), host).toBe(true);
    }
    for (const host of ['example.com', '8.8.8.8', '172.32.0.1', 'figma.com']) {
      expect(isPrivateNetworkHost(host), host).toBe(false);
    }
  });

  it('classifies protocols and paths', () => {
    expect(classifyTarget('https://example.com/x.png')).toEqual({
      protocol: 'https',
      privateNetwork: false,
    });
    expect(classifyTarget('http://localhost:3000')).toEqual({
      protocol: 'http',
      privateNetwork: true,
    });
    expect(classifyTarget('file:///tmp/x.png')).toEqual({
      protocol: 'file',
      privateNetwork: false,
    });
    expect(classifyTarget('/tmp/x.png')).toEqual({ protocol: '', privateNetwork: false });
    expect(classifyTarget('data:image/png;base64,AAA')).toEqual({
      protocol: 'data',
      privateNetwork: false,
    });
  });
});

describe('assertTargetAllowed', () => {
  it('local mode allows file:// and local paths', () => {
    expect(() => assertTargetAllowed('file:///tmp/x.png', 'local', 'design')).not.toThrow();
    expect(() => assertTargetAllowed('/tmp/x.png', 'local', 'design')).not.toThrow();
    expect(() => assertTargetAllowed('https://example.com/x.png', 'local', 'design')).not.toThrow();
  });

  it('hosted mode blocks file://, local paths and private networks', () => {
    expect(() => assertTargetAllowed('file:///etc/passwd', 'hosted', 'design')).toThrow(
      /file:\/\//,
    );
    expect(() => assertTargetAllowed('/etc/passwd', 'hosted', 'design')).toThrow(
      /local filesystem/,
    );
    expect(() => assertTargetAllowed('http://localhost:3000', 'hosted', 'page')).toThrow(
      /private-network/,
    );
    expect(() => assertTargetAllowed('http://192.168.1.10/x', 'hosted', 'page')).toThrow(
      /private-network/,
    );
  });

  it('hosted mode allows public https', () => {
    expect(() =>
      assertTargetAllowed('https://example.com/x.png', 'hosted', 'design'),
    ).not.toThrow();
  });

  it('rejects unsupported protocols everywhere', () => {
    expect(() => assertTargetAllowed('data:image/png;base64,AAA', 'local', 'design')).toThrow(
      /protocol/,
    );
    expect(() => assertTargetAllowed('ftp://example.com/x', 'local', 'design')).toThrow(/protocol/);
  });
});
