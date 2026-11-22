/**
 * #13: GET /ops/contract declares the tool's contract version and capabilities, so core (hadron-server#4882,
 * PR #4898) can refuse to send a credential to a tool that does not promise `redirects-none`.
 *
 * (First pinned for #13.) The pins here go over real HTTP (supertest) on the real app with a stubbed fetch seam. The behaviour tie is the
 * point of the file: the advertisement is judged against what `http-request` really does under `redirects: 'none'`.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { SUPPORT } from '../contract.js';
import type { FetcherDeps, HopInit, HopResponse } from '../fetcher.js';

const TOKEN = 'test-token';
const EXACT = '{"contract":"webfetch@2","capabilities":["redirects-none"]}';

function setup() {
  const calls: { url: string; init: HopInit }[] = [];
  const deps: FetcherDeps = {
    resolve: async () => {
      calls.push({ url: 'resolve', init: {} as HopInit });
      return [{ address: '93.184.216.34', family: 4 }];
    },
    dispatcherFor: () => ({ dispatcher: {}, close: async () => {} }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.startsWith('https://api.example')) {
        return new Response(null, { status: 302, headers: { location: 'https://other.example/next' } }) as unknown as HopResponse;
      }
      return new Response('landed', { status: 200, headers: { 'content-type': 'text/plain' } }) as unknown as HopResponse;
    },
  };
  return { app: createApp({ fetcherDeps: deps, serviceToken: TOKEN }), calls };
}
const authed = (t: request.Test) => t.set('authorization', `Bearer ${TOKEN}`);

describe('#13 GET /ops/contract: the route', () => {
  it('answers 200 with the byte-exact body, key order and no extra fields', async () => {
    const { app } = setup();
    const res = await authed(request(app).get('/ops/contract'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.text).toBe(EXACT);
  });

  it('refuses a request without the bearer, and with a wrong one, with 401 and no contract', async () => {
    const { app } = setup();
    for (const t of [request(app).get('/ops/contract'), request(app).get('/ops/contract').set('authorization', 'Bearer nope')]) {
      const res = await t;
      expect(res.status).toBe(401);
      expect(res.text).not.toContain('webfetch@2');
    }
  });

  it('leaves an unknown GET /ops/<x> as 404', async () => {
    const { app } = setup();
    const res = await authed(request(app).get('/ops/nothing-here'));
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('webfetch@2');
  });

  it('leaves POST /ops/contract as an unknown operation', async () => {
    const { app } = setup();
    const res = await authed(request(app).post('/ops/contract')).send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_operation');
  });

  it('makes no outbound call: no DNS and no fetch', async () => {
    const { app, calls } = setup();
    await authed(request(app).get('/ops/contract')).expect(200);
    expect(calls).toEqual([]);
  });

  it('leaves GET /info as it was (build facts only, no contract)', async () => {
    const { app } = setup();
    const res = await authed(request(app).get('/info')).expect(200);
    expect(res.body.contract).toBeUndefined();
    expect(res.body.capabilities).toBeUndefined();
    expect(res.body.redirects).toEqual({ ops: ['fetch-url', 'evaluate-url', 'http-request'], values: ['follow', 'none'], default: 'follow' });
  });
});

describe('#13 the advertisement is tied to the behaviour', () => {
  /** What http-request does under redirects:none against a 302, observed over HTTP. */
  async function observeNone() {
    const { app, calls } = setup();
    const res = await authed(request(app).post('/ops/http-request')).send({
      method: 'GET',
      url: 'https://api.example/a',
      auth: { type: 'bearer', token: 'SECRET-TOKEN-1' },
      redirects: 'none',
    });
    const hits = calls.filter((c) => c.url !== 'resolve').map((c) => c.url);
    const firstHopHeaders = calls.find((c) => c.url !== 'resolve')?.init.headers ?? {};
    return { status: res.status, upstream: res.body.status, hits, firstHopHeaders };
  }

  it('http-request with redirects:none returns the 3xx and the stub sees exactly one hit', async () => {
    const seen = await observeNone();
    expect(seen.status).toBe(200);
    expect(seen.upstream).toBe(302);
    expect(seen.hits).toEqual(['https://api.example/a']);
    // the credential went to the one hop made, and no second hop exists to receive it
    expect(JSON.stringify(seen.firstHopHeaders).toLowerCase()).toContain('secret-token-1');
  });

  it('HEAD under none is also returned as-is with one hit', async () => {
    const { app, calls } = setup();
    const res = await authed(request(app).post('/ops/http-request')).send({ method: 'HEAD', url: 'https://api.example/a', redirects: 'none' });
    expect(res.body.status).toBe(302);
    expect(calls.filter((c) => c.url !== 'resolve').map((c) => c.url)).toEqual(['https://api.example/a']);
  });

  it('redirects-none is advertised if and only if that behaviour holds', async () => {
    const seen = await observeNone();
    const holds = seen.upstream === 302 && seen.hits.length === 1;
    const { app } = setup();
    const res = await authed(request(app).get('/ops/contract')).expect(200);
    expect(res.body.capabilities.includes('redirects-none')).toBe(holds);
    expect(res.body.contract).toBe('webfetch@2');
  });

  it('a state-changing method under none is also returned as-is (the credential never reaches a second hop)', async () => {
    const { app, calls } = setup();
    const res = await authed(request(app).post('/ops/http-request')).send({
      method: 'POST',
      url: 'https://api.example/a',
      json: { a: 1 },
      auth: { type: 'bearer', token: 'SECRET-TOKEN-1' },
      redirects: 'none',
    });
    expect(res.body.status).toBe(302);
    expect(calls.filter((c) => c.url !== 'resolve').map((c) => c.url)).toEqual(['https://api.example/a']);
  });
});

describe('the declaration and the behaviour move together (flip test)', () => {
  /** Run `fn` with the switch off, always restoring it. */
  async function withSwitchOff<T>(fn: () => Promise<T>): Promise<T> {
    SUPPORT.redirectsNone = false;
    try {
      return await fn();
    } finally {
      SUPPORT.redirectsNone = true;
    }
  }

  it('with the switch off the contract drops redirects-none, byte for byte', async () => {
    const { app } = setup();
    const res = await withSwitchOff(() => authed(request(app).get('/ops/contract')));
    expect(res.status).toBe(200);
    expect(res.text).toBe('{"contract":"webfetch@2","capabilities":[]}');
  });

  it('with the switch off a GET with auth and redirects:none is REFUSED, not followed: nothing is sent', async () => {
    const { app, calls } = setup();
    const res = await withSwitchOff(() =>
      authed(request(app).post('/ops/http-request')).send({
        method: 'GET',
        url: 'https://api.example/a',
        auth: { type: 'bearer', token: 'SECRET-TOKEN-1' },
        redirects: 'none',
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
    expect(calls).toEqual([]);
  });

  it('with the switch off the follow default still follows (only `none` is refused)', async () => {
    const { app, calls } = setup();
    const res = await withSwitchOff(() => authed(request(app).post('/ops/http-request')).send({ method: 'GET', url: 'https://api.example/a' }));
    expect(res.body.status).toBe(200);
    expect(calls.filter((c) => c.url !== 'resolve').map((c) => c.url)).toEqual(['https://api.example/a', 'https://other.example/next']);
  });

  it('the switch is back on after every flip (a leaked flip would hide a failure elsewhere)', () => {
    expect(SUPPORT.redirectsNone).toBe(true);
  });
});
