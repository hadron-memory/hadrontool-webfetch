/**
 * Fetch-engine tests over fully faked seams — no network, no DNS. The fakes
 * return real `Response` objects so header/stream behavior matches undici.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthHeaders,
  performFetch,
  DEFAULT_MAX_BYTES,
  TOTAL_TIMEOUT_MS,
  type FetcherDeps,
  type FetchRequest,
  type HopInit,
  type HopResponse,
} from './fetcher.js';
import {
  FetchTimeoutError,
  TooManyRedirectsError,
  UnsupportedContentTypeError,
  UrlForbiddenError,
} from './errors.js';

interface RecordedCall {
  url: string;
  init: HopInit;
  pinnedAddresses: string[];
}

interface FakeOptions {
  /** hostname → resolved addresses; default: one public address. */
  hosts?: Record<string, string[]>;
  /** URL (string match) → response factory. */
  respond: (url: string, init: HopInit) => HopResponse | Promise<HopResponse>;
}

function makeFake(options: FakeOptions) {
  const calls: RecordedCall[] = [];
  const closedPins: string[][] = [];
  let lastPin: string[] = [];
  const deps: FetcherDeps = {
    resolve: async (hostname) => {
      const addresses = options.hosts?.[hostname] ?? ['93.184.216.34'];
      return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
    dispatcherFor: (addresses) => {
      const pinned = addresses.map((a) => a.address);
      lastPin = pinned;
      return {
        dispatcher: { pinned },
        close: async () => {
          closedPins.push(pinned);
        },
      };
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init, pinnedAddresses: lastPin });
      return options.respond(url, init);
    },
  };
  return { deps, calls, closedPins };
}

function page(body: string, init?: { status?: number; headers?: Record<string, string> }): HopResponse {
  return new Response(body, {
    status: init?.status ?? 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...init?.headers },
  }) as unknown as HopResponse;
}

function redirect(to: string, status = 302): HopResponse {
  return new Response('moved', { status, headers: { location: to, 'content-type': 'text/html' } }) as unknown as HopResponse;
}

const GET = (url: string, extra?: Partial<FetchRequest>): FetchRequest => ({
  method: 'GET',
  url,
  followRedirects: true,
  ...extra,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildAuthHeaders', () => {
  it('builds bearer, basic, and named-header credentials (lowercased keys)', () => {
    expect(buildAuthHeaders({ type: 'bearer', token: 't0k' })).toEqual({ authorization: 'Bearer t0k' });
    expect(buildAuthHeaders({ type: 'basic', username: 'u', password: 'p' })).toEqual({
      authorization: `Basic ${Buffer.from('u:p').toString('base64')}`,
    });
    expect(buildAuthHeaders({ type: 'header', name: 'X-API-Key', value: 'k' })).toEqual({ 'x-api-key': 'k' });
  });
});

describe('performFetch', () => {
  it('fetches a page through a pinned dispatcher and returns the outcome', async () => {
    const { deps, calls, closedPins } = makeFake({
      hosts: { 'example.com': ['93.184.216.34'] },
      respond: () => page('<html><body>hi</body></html>'),
    });
    const outcome = await performFetch(GET('https://example.com/page'), deps);
    expect(outcome.status).toBe(200);
    expect(outcome.finalUrl).toBe('https://example.com/page');
    expect(outcome.contentType).toBe('text/html');
    expect(outcome.bodyText).toContain('hi');
    expect(outcome.truncated).toBe(false);
    // The connection was pinned to the validated address and torn down.
    expect(calls[0].pinnedAddresses).toEqual(['93.184.216.34']);
    expect((calls[0].init.dispatcher as { pinned: string[] }).pinned).toEqual(['93.184.216.34']);
    expect(calls[0].init.headers['user-agent']).toContain('hadrontool-webfetch');
    await vi.waitFor(() => expect(closedPins.length).toBe(1));
  });

  it('refuses a host resolving to a private address WITHOUT calling fetch', async () => {
    const { deps, calls } = makeFake({
      hosts: { 'internal.example': ['10.0.0.5'] },
      respond: () => page('x'),
    });
    await expect(performFetch(GET('https://internal.example/'), deps)).rejects.toThrowError(UrlForbiddenError);
    expect(calls.length).toBe(0);
  });

  it('follows redirects with per-hop revalidation and re-pinning', async () => {
    const { deps, calls } = makeFake({
      hosts: { 'a.example': ['1.2.3.4'], 'b.example': ['5.6.7.8'] },
      respond: (url) => (url.startsWith('https://a.example') ? redirect('https://b.example/target') : page('landed')),
    });
    const outcome = await performFetch(GET('https://a.example/start'), deps);
    expect(outcome.finalUrl).toBe('https://b.example/target');
    expect(outcome.bodyText).toContain('landed');
    expect(calls.map((c) => c.pinnedAddresses[0])).toEqual(['1.2.3.4', '5.6.7.8']);
  });

  it('blocks a redirect into a private target (hostname AND IP-literal forms)', async () => {
    const { deps } = makeFake({
      hosts: { 'a.example': ['1.2.3.4'], 'evil.example': ['192.168.0.10'] },
      respond: () => redirect('https://evil.example/'),
    });
    await expect(performFetch(GET('https://a.example/'), deps)).rejects.toThrowError(UrlForbiddenError);

    const literal = makeFake({
      hosts: { 'a.example': ['1.2.3.4'] },
      respond: () => redirect('http://169.254.169.254/latest/meta-data/'),
    });
    await expect(performFetch(GET('https://a.example/'), literal.deps)).rejects.toThrowError(UrlForbiddenError);
  });

  it('caps the redirect chain', async () => {
    const { deps } = makeFake({
      hosts: { 'loop.example': ['1.2.3.4'] },
      respond: (url) => {
        const n = parseInt(new URL(url).pathname.slice(1) || '0', 10);
        return redirect(`https://loop.example/${n + 1}`);
      },
    });
    await expect(performFetch(GET('https://loop.example/0'), deps)).rejects.toThrowError(TooManyRedirectsError);
  });

  it('sends auth on the original origin and DROPS it on a cross-origin redirect', async () => {
    const { deps, calls } = makeFake({
      hosts: { 'api.example': ['1.2.3.4'], 'other.example': ['5.6.7.8'] },
      respond: (url) => (url.startsWith('https://api.example') ? redirect('https://other.example/next') : page('done')),
    });
    await performFetch(GET('https://api.example/start', { auth: { type: 'bearer', token: 'sekrit' } }), deps);
    expect(calls[0].init.headers['authorization']).toBe('Bearer sekrit');
    expect(calls[1].init.headers['authorization']).toBeUndefined();
  });

  it('DROPS caller-supplied plain headers on a cross-origin redirect', async () => {
    // Any header can be a credential (x-api-key, x-auth-token). A plain
    // header set on the request must not survive a cross-origin redirect.
    const { deps, calls } = makeFake({
      hosts: { 'api.example': ['1.2.3.4'], 'attacker.example': ['5.6.7.8'] },
      respond: (url) =>
        url.startsWith('https://api.example') ? redirect('https://attacker.example/collect') : page('done'),
    });
    await performFetch(GET('https://api.example/start', { headers: { 'x-api-key': 'sekrit' } }), deps);
    expect(calls[0].init.headers['x-api-key']).toBe('sekrit');
    expect(calls[1].init.headers['x-api-key']).toBeUndefined();
  });

  it('keeps caller headers across a SAME-origin redirect', async () => {
    const { deps, calls } = makeFake({
      hosts: { 'api.example': ['1.2.3.4'] },
      respond: (url) => (url.endsWith('/start') ? redirect('https://api.example/next') : page('done')),
    });
    await performFetch(GET('https://api.example/start', { headers: { 'x-trace': 't1' } }), deps);
    expect(calls[0].init.headers['x-trace']).toBe('t1');
    expect(calls[1].init.headers['x-trace']).toBe('t1');
  });

  it('bounds DNS resolution by the total budget (resolver never returns)', async () => {
    vi.useFakeTimers();
    const deps: FetcherDeps = {
      resolve: () => new Promise(() => {}), // hangs forever, honoring no signal
      dispatcherFor: () => ({ dispatcher: {}, close: async () => {} }),
      fetchImpl: async () => page('unreachable'),
    };
    const pending = performFetch(GET('https://slow-dns.example/'), deps);
    const assertion = expect(pending).rejects.toThrowError(FetchTimeoutError);
    await vi.advanceTimersByTimeAsync(TOTAL_TIMEOUT_MS + 1_000);
    await assertion;
  });

  it('keeps auth across a SAME-origin redirect', async () => {
    const { deps, calls } = makeFake({
      hosts: { 'api.example': ['1.2.3.4'] },
      respond: (url) => (url.endsWith('/start') ? redirect('https://api.example/next') : page('done')),
    });
    await performFetch(GET('https://api.example/start', { auth: { type: 'header', name: 'X-API-Key', value: 'k1' } }), deps);
    expect(calls[0].init.headers['x-api-key']).toBe('k1');
    expect(calls[1].init.headers['x-api-key']).toBe('k1');
  });

  it('does NOT follow redirects for non-GET; the 3xx comes back with its location', async () => {
    const { deps, calls } = makeFake({
      hosts: { 'api.example': ['1.2.3.4'] },
      respond: () => redirect('https://api.example/elsewhere', 307),
    });
    const outcome = await performFetch(
      { method: 'POST', url: 'https://api.example/create', body: '{"a":1}', contentType: 'application/json', followRedirects: false },
      deps,
    );
    expect(outcome.status).toBe(307);
    expect(outcome.headers['location']).toBe('https://api.example/elsewhere');
    expect(outcome.bodyText).toBeNull();
    expect(calls.length).toBe(1);
    expect(calls[0].init.body).toBe('{"a":1}');
    expect(calls[0].init.headers['content-type']).toBe('application/json');
  });

  it('truncates at maxBytes and flags it instead of erroring', async () => {
    const big = 'a'.repeat(5_000);
    const { deps } = makeFake({ respond: () => page(big) });
    const outcome = await performFetch(GET('https://example.com/big', { maxBytes: 1_000 }), deps);
    expect(outcome.truncated).toBe(true);
    expect(outcome.bodyText?.length).toBe(1_000);
  });

  it('defaults the cap when none is given', async () => {
    const { deps } = makeFake({ respond: () => page('small') });
    const outcome = await performFetch(GET('https://example.com/'), deps);
    expect(outcome.truncated).toBe(false);
    expect(DEFAULT_MAX_BYTES).toBeGreaterThan(1_000_000);
  });

  it('rejects binary content types', async () => {
    const { deps } = makeFake({
      respond: () =>
        new Response('....', { status: 200, headers: { 'content-type': 'image/png' } }) as unknown as HopResponse,
    });
    await expect(performFetch(GET('https://example.com/logo.png'), deps)).rejects.toThrowError(UnsupportedContentTypeError);
  });

  it('times out when the connection hangs (headers never arrive)', async () => {
    vi.useFakeTimers();
    const { deps } = makeFake({
      respond: (_url, init) =>
        new Promise<HopResponse>((_, reject) => {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), {
            once: true,
          });
        }),
    });
    const pending = performFetch(GET('https://slow.example/'), deps);
    const assertion = expect(pending).rejects.toThrowError(FetchTimeoutError);
    await vi.advanceTimersByTimeAsync(TOTAL_TIMEOUT_MS + 1_000);
    await assertion;
  });

  it('times out when the BODY read stalls (the ms-exchange finding)', async () => {
    vi.useFakeTimers();
    const stalledBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('first chunk'));
        // ...and then never delivers the rest, and never closes.
      },
    });
    const { deps } = makeFake({
      respond: () =>
        ({
          status: 200,
          headers: new Headers({ 'content-type': 'text/html' }),
          body: stalledBody,
        }) as unknown as HopResponse,
    });
    const pending = performFetch(GET('https://stall.example/'), deps);
    const assertion = expect(pending).rejects.toThrowError(FetchTimeoutError);
    await vi.advanceTimersByTimeAsync(TOTAL_TIMEOUT_MS + 1_000);
    await assertion;
  });
});
