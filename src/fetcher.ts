/**
 * The guarded fetch engine shared by every operation.
 *
 * Per hop: parse → resolve + validate (guard.ts) → connect PINNED to the
 * validated addresses (custom undici dispatcher lookup; SNI and Host keep
 * the original hostname) → manual redirect handling with full re-validation
 * per hop. One AbortController budget covers the whole chain INCLUDING the
 * body read (the ms-exchange body-stall finding).
 *
 * Credential rules: the caller-supplied auth AND every caller-supplied
 * header attach only to hops whose origin equals the ORIGINAL request's
 * origin — a redirect that leaves the origin proceeds with neither. (Any
 * header can be a credential — `x-api-key`, `x-auth-token` — so the plain
 * header channel gets the same cross-origin drop as `auth`.) Non-GET/HEAD
 * requests never follow redirects (the 3xx is returned to the caller).
 */

import { lookup } from 'node:dns/promises';
import { Agent, fetch as undiciFetch } from 'undici';
import {
  FetchFailedError,
  FetchTimeoutError,
  TooManyRedirectsError,
  UnsupportedContentTypeError,
  WebfetchToolError,
} from './errors.js';
import { parseUrl, resolvePinned, type ResolvedAddress, type Resolver } from './guard.js';

export const MAX_REDIRECTS = 3;
export const TOTAL_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BYTES = 2_000_000;
export const HARD_MAX_BYTES = 5_000_000;
const USER_AGENT = 'hadrontool-webfetch/0.1 (+https://hadronmemory.com)';

/** Caller-supplied credential — built into a header, never stored or logged. */
export type AuthSpec =
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'header'; name: string; value: string };

/** Build the header(s) an AuthSpec contributes. Keys are lowercase. */
export function buildAuthHeaders(auth: AuthSpec): Record<string, string> {
  switch (auth.type) {
    case 'bearer':
      return { authorization: `Bearer ${auth.token}` };
    case 'basic':
      return { authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` };
    case 'header':
      return { [auth.name.toLowerCase()]: auth.value };
  }
}

/** Structural response shape — satisfied by the global fetch Response. */
export interface HopResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

export interface HopInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect: 'manual';
  signal: AbortSignal;
  dispatcher?: unknown;
}

export type FetchImpl = (url: string, init: HopInit) => Promise<HopResponse>;

/** A pinned dispatcher plus its teardown (teardown never throws). */
export interface PinnedDispatcher {
  dispatcher: unknown;
  close(): Promise<void>;
}

/** The injectable seams — production defaults below, fakes in tests. */
export interface FetcherDeps {
  resolve: Resolver;
  fetchImpl: FetchImpl;
  dispatcherFor(addresses: ResolvedAddress[]): PinnedDispatcher;
}

export const defaultDeps: FetcherDeps = {
  resolve: (hostname) => lookup(hostname, { all: true, verbatim: true }),
  fetchImpl: (url, init) =>
    undiciFetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      redirect: init.redirect,
      signal: init.signal,
      dispatcher: init.dispatcher,
      // undici's RequestInit typing lags the dispatcher option.
    } as never) as unknown as Promise<HopResponse>,
  dispatcherFor(addresses) {
    // The connection is pinned by overriding DNS at the socket layer: the
    // socket dials the pre-validated address while TLS SNI and the Host
    // header still carry the original hostname.
    // Spec: cor:web:010:01 (connection pinning — no connect-time re-resolution).
    const agent = new Agent({
      connect: {
        lookup(_hostname, options, callback) {
          const list = addresses.map((a) => ({ address: a.address, family: a.family }));
          if ((options as { all?: boolean }).all) {
            (callback as unknown as (err: null, addrs: typeof list) => void)(null, list);
          } else {
            callback(null, list[0].address, list[0].family);
          }
        },
      },
    });
    return { dispatcher: agent, close: () => agent.close() };
  },
};

export interface FetchRequest {
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  /** Extra request headers — keys already lowercased + validated by the ops layer. */
  headers?: Record<string, string>;
  /** Pre-serialized request body (non-GET/HEAD only). */
  body?: string;
  /** Content-type to apply when a body is present and none was supplied. */
  contentType?: string;
  auth?: AuthSpec;
  maxBytes?: number;
  followRedirects: boolean;
}

export interface FetchOutcome {
  finalUrl: string;
  status: number;
  /** Lowercased media type of the final response, or null when absent. */
  contentType: string | null;
  /** Allow-listed response-header subset. */
  headers: Record<string, string>;
  /** Decoded body text; null for HEAD responses and unfollowed redirects. */
  bodyText: string | null;
  truncated: boolean;
}

/** Response headers worth passing back — nothing else crosses the contract. */
const RESPONSE_HEADER_ALLOWLIST = [
  'content-type',
  'content-length',
  'location',
  'etag',
  'last-modified',
  'cache-control',
  'retry-after',
  'www-authenticate',
  'content-language',
];

function subsetHeaders(res: HopResponse): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of RESPONSE_HEADER_ALLOWLIST) {
    const value = res.headers.get(name);
    if (value != null) out[name] = value;
  }
  return out;
}

function mediaType(res: HopResponse): string | null {
  const raw = res.headers.get('content-type');
  if (!raw) return null;
  return raw.split(';')[0].trim().toLowerCase();
}

/** Textual types we return; anything else is unsupported_content_type. */
export function isTextualType(mediaType: string | null): boolean {
  if (mediaType == null) return true; // absent → treat as text, best effort
  return (
    mediaType.startsWith('text/') ||
    mediaType === 'application/json' ||
    mediaType === 'application/xml' ||
    mediaType === 'application/xhtml+xml' ||
    mediaType === 'application/javascript' ||
    mediaType === 'application/x-www-form-urlencoded' ||
    mediaType.endsWith('+json') ||
    mediaType.endsWith('+xml')
  );
}

function cancelBody(res: HopResponse): Promise<void> {
  return Promise.resolve(res.body?.cancel()).then(
    () => undefined,
    () => undefined,
  );
}

/** Teardown is fire-and-forget and never throws (ms-exchange review finding). */
function closePin(pin: PinnedDispatcher): void {
  void pin.close().catch(() => {});
}

/**
 * Resolve + validate the URL's host under the total budget. `dns.lookup`
 * honors no AbortSignal, so a hostile/stalled resolver would otherwise stall
 * the request past the timeout — and each hop re-resolves. Racing the abort
 * keeps DNS inside the one budget the rest of the chain already respects.
 *
 * Spec: cor:web:010:01 (the total budget covers DNS resolution + the body read).
 */
async function resolveWithBudget(
  url: URL,
  resolve: Resolver,
  signal: AbortSignal,
): Promise<ResolvedAddress[]> {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new FetchTimeoutError(TOTAL_TIMEOUT_MS / 1000));
    // Check inside the executor (mirrors readCapped): an abort already raised
    // before we subscribe still rejects, with no gap to the addEventListener.
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => {}); // pre-attach so a non-raced rejection is never unhandled
  try {
    return await Promise.race([resolvePinned(url, resolve), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Read the body under the byte cap, racing the abort signal so a stalled
 * stream cannot outlive the total budget. Exceeding the cap TRUNCATES
 * (flagged), it does not error.
 */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: '', truncated: false };
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let bytes = 0;
  let truncated = false;
  let onAbort: (() => void) | undefined;
  const abortError = new DOMException('The operation was aborted.', 'AbortError');
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => {}); // pre-attach so a non-raced rejection is never unhandled
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        const keep = value.byteLength - (bytes - maxBytes);
        text += decoder.decode(value.subarray(0, keep), { stream: true });
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
  text += decoder.decode();
  return { text, truncated };
}

/** Execute a guarded fetch, following the redirect policy in FetchRequest. */
export async function performFetch(req: FetchRequest, deps: FetcherDeps = defaultDeps): Promise<FetchOutcome> {
  let url = parseUrl(req.url);
  const authOrigin = url.origin;
  const authHeaders = req.auth ? buildAuthHeaders(req.auth) : {};
  const maxBytes = Math.min(req.maxBytes ?? DEFAULT_MAX_BYTES, HARD_MAX_BYTES);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
  try {
    for (let hop = 0; ; hop++) {
      const addresses = await resolveWithBudget(url, deps.resolve, controller.signal);
      const pin = deps.dispatcherFor(addresses);
      // Caller headers AND credentials attach ONLY on the original origin — a
      // cross-origin redirect must carry neither, because any caller header
      // can be a credential (x-api-key, x-auth-token, …) and would otherwise
      // leak to the redirect target.
      // Spec: cor:web:010:02 (origin-scoped attach; drop credential + all headers cross-origin).
      const sameOrigin = url.origin === authOrigin;
      const headers: Record<string, string> = {
        'user-agent': USER_AGENT,
        ...(sameOrigin ? req.headers ?? {} : {}),
        ...(sameOrigin ? authHeaders : {}),
      };
      if (req.body != null && req.contentType && headers['content-type'] == null) {
        headers['content-type'] = req.contentType;
      }
      let res: HopResponse;
      try {
        res = await deps.fetchImpl(url.toString(), {
          method: req.method,
          headers,
          body: req.body,
          redirect: 'manual',
          signal: controller.signal,
          dispatcher: pin.dispatcher,
        });
      } catch (err) {
        closePin(pin);
        if (controller.signal.aborted) throw new FetchTimeoutError(TOTAL_TIMEOUT_MS / 1000);
        throw new FetchFailedError(String((err as Error)?.message ?? err));
      }

      const status = res.status;
      const location = status >= 300 && status < 400 ? res.headers.get('location') : null;
      if (location != null && req.followRedirects) {
        await cancelBody(res);
        closePin(pin);
        if (hop >= MAX_REDIRECTS) throw new TooManyRedirectsError(MAX_REDIRECTS);
        url = parseUrl(new URL(location, url).toString());
        continue;
      }
      if (location != null && !req.followRedirects) {
        const subset = subsetHeaders(res);
        await cancelBody(res);
        closePin(pin);
        return { finalUrl: url.toString(), status, contentType: mediaType(res), headers: subset, bodyText: null, truncated: false };
      }
      if (req.method === 'HEAD') {
        const subset = subsetHeaders(res);
        await cancelBody(res);
        closePin(pin);
        return { finalUrl: url.toString(), status, contentType: mediaType(res), headers: subset, bodyText: null, truncated: false };
      }

      const ct = mediaType(res);
      if (!isTextualType(ct)) {
        await cancelBody(res);
        closePin(pin);
        throw new UnsupportedContentTypeError(ct ?? 'unknown');
      }
      let bodyRead: { text: string; truncated: boolean };
      try {
        bodyRead = await readCapped(res.body, maxBytes, controller.signal);
      } catch (err) {
        closePin(pin);
        if (err instanceof WebfetchToolError) throw err;
        if (controller.signal.aborted) throw new FetchTimeoutError(TOTAL_TIMEOUT_MS / 1000);
        throw new FetchFailedError('failed while reading the response body');
      }
      closePin(pin);
      return {
        finalUrl: url.toString(),
        status,
        contentType: ct,
        headers: subsetHeaders(res),
        bodyText: bodyRead.text,
        truncated: bodyRead.truncated,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}
