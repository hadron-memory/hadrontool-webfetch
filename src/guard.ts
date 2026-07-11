/**
 * Egress guard — the cor:api:130:02 policy, ported from hadron-server's
 * src/lib/webFetch.ts (PR-486-reviewed) with GraphQL errors swapped for this
 * tool's typed catalog.
 *
 * `isForbiddenAddress` / `embeddedIpv4` are verbatim copies of the core
 * implementation — keep them in sync until core's importNode delegates its
 * fetch to this tool.
 *
 * Unlike core's resolve-then-fetch (a documented, accepted TOCTOU for
 * user-initiated imports), this tool PINS the validated addresses: the
 * resolver output returned by `resolvePinned` feeds a custom dispatcher
 * lookup, so the actual connection can never be re-resolved to a private
 * address by a hostile nameserver (cor:api:130:02's condition for exposing
 * fetch to autonomous agents).
 */

import { isIP } from 'node:net';
import { UrlForbiddenError, UrlUnresolvableError, ValidationError } from './errors.js';

export const MAX_URL_CHARS = 2_000;

/**
 * True when the address must not be fetched server-side. Covers the classic
 * bypass shapes: decimal IPv4 literals arrive here already normalized by the
 * resolver, `[::1]` via the IPv6 branch, IPv4-mapped IPv6 via unwrapping,
 * and the cloud metadata endpoint via 169.254/16.
 */
export function isForbiddenAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const octets = ip.split('.').map(Number);
    const [a, b] = octets;
    if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return true;
    return (
      a === 0 || // 0.0.0.0/8 ("this network" — hits localhost on Linux)
      a === 10 || // 10/8
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
      (a === 169 && b === 254) || // link-local incl. 169.254.169.254 metadata
      (a === 172 && b >= 16 && b <= 31) || // 172.16/12
      (a === 192 && b === 168) || // 192.168/16
      a >= 224 // multicast + reserved + broadcast
    );
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    // IPv4 embedded in IPv6 — mapped (::ffff:0:0/96) or the deprecated
    // IPv4-compatible form (::/96) — must be validated by the IPv4 rules.
    // BOTH textual shapes count: dotted (::ffff:127.0.0.1) AND hex
    // (::ffff:7f00:1) — the hex form bypassed a dotted-only unwrap
    // (PR-486 review, Codex P1 / Gemini critical).
    const embedded = embeddedIpv4(lower);
    if (embedded != null) return isForbiddenAddress(embedded);
    if (lower === '::' || lower === '::1') return true; // unspecified + loopback
    if (/^f[cd]/.test(lower)) return true; // fc00::/7 ULA
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
    if (/^ff/.test(lower)) return true; // multicast
    return false;
  }
  // Not an IP at all — callers pass resolver output, so treat as forbidden.
  return true;
}

/**
 * Extract the IPv4 address embedded in an IPv4-mapped (::ffff:0:0/96) or
 * IPv4-compatible (::/96, deprecated but OS-honored) IPv6 literal, in EITHER
 * textual shape (dotted or hex groups). Returns null when the address is
 * plain IPv6. Works on the full 8-group expansion so `::` compression and
 * leading-zero variants can't dodge the check.
 */
export function embeddedIpv4(ip6: string): string | null {
  let s = ip6.toLowerCase();
  // Fold a trailing dotted-quad into two hex groups so the expansion below
  // is uniform.
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const parts = dotted[2].split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p > 255)) return null;
    s =
      dotted[1] +
      ((parts[0] << 8) | parts[1]).toString(16) +
      ':' +
      ((parts[2] << 8) | parts[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 && missing < 0) return null;
  const groups =
    halves.length === 2 ? [...head, ...Array<string>(missing).fill('0'), ...tail] : head;
  if (groups.length !== 8) return null;
  const g = groups.map((x) => parseInt(x || '0', 16));
  if (g.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  const zeroTo = (i: number) => g.slice(0, i).every((n) => n === 0);
  const isMapped = zeroTo(5) && g[5] === 0xffff;
  const isCompat = zeroTo(6) && (g[6] !== 0 || g[7] > 1); // excludes :: and ::1 (plain v6)
  if (!isMapped && !isCompat) return null;
  return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
}

/** Parse and structurally validate a caller-supplied URL (scheme + length). */
export function parseUrl(raw: string): URL {
  if (raw.length > MAX_URL_CHARS) {
    throw new ValidationError('url', `URL exceeds ${MAX_URL_CHARS} characters`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('url', 'malformed URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError('url', `unsupported URL scheme "${url.protocol}" — only http and https are allowed`);
  }
  return url;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** DNS resolution seam — injectable so tests never touch the network. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

/**
 * Validate a URL's host and return the addresses to PIN the connection to.
 * IP literals are validated directly; hostnames are resolved and EVERY
 * address must be public — a mixed answer is exactly the rebinding trick
 * this guard exists for. The returned list feeds the pinned dispatcher; the
 * actual fetch never resolves DNS again.
 */
export async function resolvePinned(url: URL, resolve: Resolver): Promise<ResolvedAddress[]> {
  // URL.hostname wraps IPv6 in brackets — strip for isIP/lookup.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(host);
  if (literalFamily) {
    if (isForbiddenAddress(host)) throw new UrlForbiddenError(host);
    return [{ address: host, family: literalFamily }];
  }
  let addrs: ResolvedAddress[];
  try {
    addrs = await resolve(host);
  } catch {
    throw new UrlUnresolvableError(host);
  }
  if (addrs.length === 0) throw new UrlUnresolvableError(host);
  for (const { address } of addrs) {
    if (isForbiddenAddress(address)) throw new UrlForbiddenError(host);
  }
  return addrs;
}
