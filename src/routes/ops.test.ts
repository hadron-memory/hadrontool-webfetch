/**
 * End-to-end ops-plane tests: real HTTP through supertest, fake fetch seams.
 * Covers the bearer gate, the three operations, and the no-credential-echo
 * guarantee on error paths.
 */

import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import type { FetcherDeps, HopInit, HopResponse } from '../fetcher.js';

const TOKEN = 'test-token';

function fakeDeps(respond: (url: string, init: HopInit) => HopResponse, hosts?: Record<string, string[]>) {
  const calls: { url: string; init: HopInit }[] = [];
  const deps: FetcherDeps = {
    resolve: async (hostname) =>
      (hosts?.[hostname] ?? ['93.184.216.34']).map((address) => ({ address, family: 4 })),
    dispatcherFor: () => ({ dispatcher: {}, close: async () => {} }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return respond(url, init);
    },
  };
  return { deps, calls };
}

function html(body: string, status = 200, headers: Record<string, string> = {}): HopResponse {
  return new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } }) as unknown as HopResponse;
}

function app(respond: (url: string, init: HopInit) => HopResponse, hosts?: Record<string, string[]>) {
  const { deps, calls } = fakeDeps(respond, hosts);
  return { app: createApp({ fetcherDeps: deps, serviceToken: TOKEN }), calls };
}

const PAGE = '<html><head><title>T</title></head><body><h1>Hello</h1><a href="/a">A</a></body></html>';

describe('auth gate', () => {
  it('rejects ops and /info without the bearer, allows health open', async () => {
    const { app: a } = app(() => html(PAGE));
    await request(a).post('/ops/fetch-url').send({ url: 'https://example.com/' }).expect(401);
    await request(a).get('/info').expect(401);
    await request(a).get('/healthz').expect(200);
  });

  it('accepts the bearer and lists operations on /info', async () => {
    const { app: a } = app(() => html(PAGE));
    const res = await request(a).get('/info').set('authorization', `Bearer ${TOKEN}`).expect(200);
    expect(res.body.operations).toEqual(['fetch-url', 'check-url', 'http-request']);
  });
});

describe('POST /ops/fetch-url', () => {
  it('returns markdown content, title, and the external-source tag', async () => {
    const { app: a } = app(() => html(PAGE));
    const res = await request(a)
      .post('/ops/fetch-url')
      .set('authorization', `Bearer ${TOKEN}`)
      .send({ url: 'https://example.com/page' })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe(200);
    expect(res.body.title).toBe('T');
    expect(res.body.content).toContain('# Hello');
    expect(res.body.source).toBe('external');
  });

  it('returns the link graph for format=links', async () => {
    const { app: a } = app(() => html(PAGE));
    const res = await request(a)
      .post('/ops/fetch-url')
      .set('authorization', `Bearer ${TOKEN}`)
      .send({ url: 'https://example.com/page', format: 'links' })
      .expect(200);
    expect(res.body.links).toEqual([{ text: 'A', href: 'https://example.com/a' }]);
    expect(res.body.content).toBeUndefined();
  });

  it('passes non-HTML text through untouched', async () => {
    const { app: a } = app(
      () => new Response('{"x":1}', { headers: { 'content-type': 'application/json' } }) as unknown as HopResponse,
    );
    const res = await request(a)
      .post('/ops/fetch-url')
      .set('authorization', `Bearer ${TOKEN}`)
      .send({ url: 'https://api.example.com/data' })
      .expect(200);
    expect(res.body.content).toBe('{"x":1}');
  });

  it('rejects non-content-negotiation headers', async () => {
    const { app: a } = app(() => html(PAGE));
    const res = await request(a)
      .post('/ops/fetch-url')
      .set('authorization', `Bearer ${TOKEN}`)
      .send({ url: 'https://example.com/', headers: { 'x-custom': '1' } })
      .expect(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('surfaces the egress policy as url_forbidden', async () => {
    const { app: a } = app(() => html(PAGE), { 'internal.example': ['10.1.2.3'] });
    const res = await request(a)
      .post('/ops/fetch-url')
      .set('authorization', `Bearer ${TOKEN}`)
      .send({ url: 'https://internal.example/' })
      .expect(403);
    expect(res.body.error).toBe('url_forbidden');
  });
});

describe('POST /ops/check-url', () => {
  it('probes with HEAD and reports an unfollowed redirect', async () => {
    const { app: a, calls } = app(
      () =>
        new Response(null, {
          status: 301,
          headers: { location: 'https://example.com/new', 'content-type': 'text/html' },
        }) as unknown as HopResponse,
    );
    const res = await request(a)
      .post('/ops/check-url')
      .set('authorization', `Bearer ${TOKEN}`)
      .send({ url: 'https://example.com/old' })
      .expect(200);
    expect(calls[0].init.method).toBe('HEAD');
    expect(res.body.status).toBe(301);
    expect(res.body.redirectLocation).toBe('https://example.com/new');
  });
});

describe('POST /ops/http-request', () => {
  it('POSTs json with auth and parses the JSON response', async () => {
    const { app: a, calls } = app(
      () => new Response('{"created":true}', { status: 201, headers: { 'content-type': 'application/json' } }) as unknown as HopResponse,
    );
    const res = await request(a)
      .post('/ops/http-request')
      .set('authorization', `Bearer ${TOKEN}`)
      .send({
        method: 'POST',
        url: 'https://api.example.com/things',
        json: { name: 'x' },
        auth: { type: 'bearer', token: 'remote-secret' },
      })
      .expect(200);
    expect(res.body.status).toBe(201);
    expect(res.body.body).toEqual({ created: true });
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe('{"name":"x"}');
    expect(calls[0].init.headers['content-type']).toBe('application/json');
    expect(calls[0].init.headers['authorization']).toBe('Bearer remote-secret');
  });

  it('rejects a body on GET', async () => {
    const { app: a } = app(() => html(PAGE));
    const res = await request(a)
      .post('/ops/http-request')
      .set('authorization', `Bearer ${TOKEN}`)
      .send({ method: 'GET', url: 'https://example.com/', json: { a: 1 } })
      .expect(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('does not leak a custom credential header to a cross-origin redirect target', async () => {
    const { app: a, calls } = app(
      (url) =>
        url.startsWith('https://api.example')
          ? (new Response('m', {
              status: 302,
              headers: { location: 'https://attacker.example/collect', 'content-type': 'text/html' },
            }) as unknown as HopResponse)
          : html('done'),
      { 'api.example': ['1.2.3.4'], 'attacker.example': ['5.6.7.8'] },
    );
    await request(a)
      .post('/ops/http-request')
      .set('authorization', `Bearer ${TOKEN}`)
      .send({ method: 'GET', url: 'https://api.example/start', headers: { 'x-api-key': 'sekrit' } })
      .expect(200);
    expect(calls[0].init.headers['x-api-key']).toBe('sekrit');
    expect(calls[1].init.headers['x-api-key']).toBeUndefined();
  });

  it('rejects header values containing control characters (CRLF injection)', async () => {
    const { app: a } = app(() => html(PAGE));
    const res = await request(a)
      .post('/ops/http-request')
      .set('authorization', `Bearer ${TOKEN}`)
      .send({ method: 'GET', url: 'https://example.com/', headers: { 'x-inject': 'a\r\nx-evil: 1' } })
      .expect(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('rejects URL-embedded credentials without echoing the password', async () => {
    const { app: a, calls } = app(() => html(PAGE));
    const res = await request(a)
      .post('/ops/http-request')
      .set('authorization', `Bearer ${TOKEN}`)
      .send({ method: 'GET', url: 'https://user:sup3r-sekrit@example.com/' })
      .expect(400);
    expect(res.body.error).toBe('validation_error');
    // Rejected at validation, so the URL never reaches undici (whose error
    // message would echo the full URL, incl. the password, via fetch_failed).
    expect(calls.length).toBe(0);
    expect(JSON.stringify(res.body)).not.toContain('sup3r-sekrit');
  });

  it('rejects credentials smuggled through plain headers', async () => {
    const { app: a } = app(() => html(PAGE));
    const res = await request(a)
      .post('/ops/http-request')
      .set('authorization', `Bearer ${TOKEN}`)
      .send({ method: 'GET', url: 'https://example.com/', headers: { Authorization: 'Bearer leak' } })
      .expect(400);
    expect(res.body.error).toBe('validation_error');
    expect(res.body.reason).toContain('auth');
  });

  it('never echoes credentials on error paths', async () => {
    const { app: a } = app(() => html(PAGE));
    // Invalid method → zod error; the auth token must not appear anywhere.
    const res = await request(a)
      .post('/ops/http-request')
      .set('authorization', `Bearer ${TOKEN}`)
      .send({ method: 'YEET', url: 'https://example.com/', auth: { type: 'bearer', token: 'super-sekrit-42' } })
      .expect(400);
    expect(JSON.stringify(res.body)).not.toContain('super-sekrit-42');
  });
});

describe('unknown operation', () => {
  it('404s with the operation list', async () => {
    const { app: a } = app(() => html(PAGE));
    const res = await request(a)
      .post('/ops/does-not-exist')
      .set('authorization', `Bearer ${TOKEN}`)
      .send({})
      .expect(404);
    expect(res.body.error).toBe('unknown_operation');
    expect(res.body.operations).toContain('fetch-url');
  });
});
