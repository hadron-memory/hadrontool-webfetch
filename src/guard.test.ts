/**
 * Egress-guard unit tests. The address classifier cases are ported from
 * hadron-server's src/lib/webFetch.test.ts (PR-486) — the classic SSRF
 * bypass shapes — plus the pinning-resolver behavior this tool adds.
 */

import { describe, it, expect } from 'vitest';
import { embeddedIpv4, isForbiddenAddress, parseUrl, resolvePinned } from './guard.js';
import { UrlForbiddenError, UrlUnresolvableError, ValidationError } from './errors.js';

describe('isForbiddenAddress', () => {
  it('blocks the private/reserved IPv4 ranges', () => {
    for (const ip of [
      '0.0.0.0',
      '0.1.2.3',
      '10.0.0.1',
      '10.255.255.255',
      '100.64.0.1', // CGNAT
      '100.127.255.254',
      '127.0.0.1',
      '127.8.9.10',
      '169.254.0.1',
      '169.254.169.254', // cloud metadata
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      '224.0.0.1', // multicast
      '255.255.255.255',
    ]) {
      expect(isForbiddenAddress(ip), ip).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1']) {
      expect(isForbiddenAddress(ip), ip).toBe(false);
    }
  });

  it('blocks loopback/unspecified/ULA/link-local/multicast IPv6', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1']) {
      expect(isForbiddenAddress(ip), ip).toBe(true);
    }
  });

  it('unwraps IPv4-mapped IPv6 (dotted AND hex forms) and applies the IPv4 rules', () => {
    // Dotted shape.
    expect(isForbiddenAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isForbiddenAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isForbiddenAddress('::ffff:8.8.8.8')).toBe(false);
    // Hex shape — the bypass Codex/Gemini flagged (PR-486): the OS treats
    // these identically to the dotted form.
    expect(isForbiddenAddress('::ffff:7f00:1')).toBe(true); // 127.0.0.1
    expect(isForbiddenAddress('::ffff:7f00:0001')).toBe(true); // leading zeros
    expect(isForbiddenAddress('::ffff:a9fe:a9fe')).toBe(true); // 169.254.169.254
    expect(isForbiddenAddress('::ffff:0a00:0001')).toBe(true); // 10.0.0.1
    expect(isForbiddenAddress('::ffff:808:808')).toBe(false); // 8.8.8.8
    // Deprecated IPv4-compatible form (::/96) — also unwrapped.
    expect(isForbiddenAddress('::7f00:1')).toBe(true); // 127.0.0.1
    expect(isForbiddenAddress('::127.0.0.1')).toBe(true);
    expect(isForbiddenAddress('::808:808')).toBe(false); // 8.8.8.8
  });

  it('embeddedIpv4 extracts from both textual shapes and ignores plain IPv6', () => {
    expect(embeddedIpv4('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(embeddedIpv4('::ffff:192.168.0.1')).toBe('192.168.0.1');
    expect(embeddedIpv4('::a9fe:a9fe')).toBe('169.254.169.254');
    expect(embeddedIpv4('2606:4700:4700::1111')).toBeNull();
    expect(embeddedIpv4('::1')).toBeNull(); // plain loopback, not embedded v4
    expect(embeddedIpv4('::')).toBeNull();
  });

  it('allows public IPv6', () => {
    expect(isForbiddenAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('treats non-IP input as forbidden (defense in depth)', () => {
    expect(isForbiddenAddress('localhost')).toBe(true);
    expect(isForbiddenAddress('')).toBe(true);
  });
});

describe('parseUrl', () => {
  it('accepts http and https', () => {
    expect(parseUrl('https://example.com/page').hostname).toBe('example.com');
    expect(parseUrl('http://example.com').protocol).toBe('http:');
  });

  it('rejects other schemes as validation_error', () => {
    for (const bad of ['file:///etc/passwd', 'ftp://example.com', 'gopher://x', 'javascript:alert(1)']) {
      expect(() => parseUrl(bad), bad).toThrowError(ValidationError);
    }
  });

  it('rejects malformed and oversized URLs', () => {
    expect(() => parseUrl('not a url')).toThrowError(ValidationError);
    expect(() => parseUrl(`https://example.com/${'x'.repeat(2100)}`)).toThrowError(ValidationError);
  });

  it('rejects URL-embedded credentials (userinfo) — auth must go via the auth field', () => {
    expect(() => parseUrl('https://user:pass@example.com/')).toThrowError(ValidationError);
    expect(() => parseUrl('https://user@example.com/')).toThrowError(ValidationError);
    expect(parseUrl('https://example.com/').username).toBe('');
  });
});

describe('resolvePinned', () => {
  const resolveTo = (addresses: { address: string; family: number }[]) => async () => addresses;

  it('returns the resolved addresses for a public host (the pin set)', async () => {
    const addrs = await resolvePinned(parseUrl('https://example.com/'), resolveTo([{ address: '93.184.216.34', family: 4 }]));
    expect(addrs).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('rejects when ANY resolved address is private (the rebinding trick)', async () => {
    const mixed = resolveTo([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    await expect(resolvePinned(parseUrl('https://evil.example/'), mixed)).rejects.toThrowError(UrlForbiddenError);
  });

  it('rejects a private-only answer', async () => {
    await expect(
      resolvePinned(parseUrl('https://internal.example/'), resolveTo([{ address: '169.254.169.254', family: 4 }])),
    ).rejects.toThrowError(UrlForbiddenError);
  });

  it('maps resolution failure and empty answers to url_unresolvable', async () => {
    await expect(
      resolvePinned(parseUrl('https://nx.example/'), async () => {
        throw new Error('ENOTFOUND');
      }),
    ).rejects.toThrowError(UrlUnresolvableError);
    await expect(resolvePinned(parseUrl('https://nx.example/'), resolveTo([]))).rejects.toThrowError(UrlUnresolvableError);
  });

  it('validates IP-literal hosts directly without calling the resolver', async () => {
    let called = false;
    const spyResolve = async () => {
      called = true;
      return [{ address: '93.184.216.34', family: 4 }];
    };
    const addrs = await resolvePinned(parseUrl('http://93.184.216.34/x'), spyResolve);
    expect(addrs).toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect(called).toBe(false);
    await expect(resolvePinned(parseUrl('http://169.254.169.254/latest'), spyResolve)).rejects.toThrowError(UrlForbiddenError);
    await expect(resolvePinned(parseUrl('http://[::1]:8080/'), spyResolve)).rejects.toThrowError(UrlForbiddenError);
    expect(called).toBe(false);
  });
});
