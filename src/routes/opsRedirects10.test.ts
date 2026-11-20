/**
 * #10: optional `redirects: "follow" | "none"` on the auth-taking ops that follow
 * redirects (fetch-url, evaluate-url, http-request). Spec: cor:web:010:02.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import type { FetcherDeps, HopInit, HopResponse } from '../fetcher.js';

const TOKEN = 'test-token';
const AUTH = { type: 'bearer', token: 'SECRET-TOKEN-1' };
const TARGET = 'https://other.example/next';

function setup() {
  const calls: { url: string; init: HopInit }[] = [];
  const deps: FetcherDeps = {
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    dispatcherFor: () => ({ dispatcher: {}, close: async () => {} }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.startsWith('https://api.example')) {
        return new Response(null, { status: 302, headers: { location: TARGET } }) as unknown as HopResponse;
      }
      return new Response('<html><body>landed</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }) as unknown as HopResponse;
    },
  };
  return { app: createApp({ fetcherDeps: deps, serviceToken: TOKEN }), calls };
}
const post = (a: ReturnType<typeof setup>['app'], op: string, body: Record<string, unknown>) =>
  request(a).post(`/ops/${op}`).set('authorization', `Bearer ${TOKEN}`).send(body);

const CASES: [string, Record<string, unknown>][] = [
  ['fetch-url', { url: 'https://api.example/a', auth: AUTH }],
  ['evaluate-url', { url: 'https://api.example/a', auth: AUTH, conditions: [{ id: 'p', type: 'selector_exists', selector: 'body' }] }],
  ['http-request', { method: 'GET', url: 'https://api.example/a', auth: AUTH }],
];

describe('#10 redirects option', () => {
  it.each(CASES)('%s with redirects:none returns the 302 and never requests the target', async (op, input) => {
    const { app, calls } = setup();
    const res = await post(app, op, { ...input, redirects: 'none' }).expect(200);
    expect(res.body.status).toBe(302);
    const loc = res.body.redirectLocation ?? res.body.headers?.location;
    expect(loc).toBe(TARGET);
    expect(calls.map((c) => c.url)).toEqual(['https://api.example/a']);
  });

  it.each(CASES)('%s default and explicit follow both still follow to the target', async (op, input) => {
    for (const extra of [{}, { redirects: 'follow' }]) {
      const { app, calls } = setup();
      const res = await post(app, op, { ...input, ...extra }).expect(200);
      expect(res.body.status).toBe(200);
      expect(res.body.redirectLocation).toBeUndefined();
      expect(calls.map((c) => c.url)).toEqual(['https://api.example/a', TARGET]);
    }
  });

  it.each(CASES)('%s refuses an unknown redirects value with validation_error', async (op, input) => {
    const { app, calls } = setup();
    const res = await post(app, op, { ...input, redirects: 'manual' }).expect(400);
    expect(res.body.error).toBe('validation_error');
    expect(calls).toEqual([]);
  });

  it('check-url takes no redirects field', async () => {
    const { app, calls } = setup();
    const res = await post(app, 'check-url', { url: 'https://api.example/a', redirects: 'follow' }).expect(400);
    expect(res.body.error).toBe('validation_error');
    expect(calls).toEqual([]);
  });

  it('POST with redirects:follow is still NOT followed (cor:web:010:02)', async () => {
    const { app, calls } = setup();
    const res = await post(app, 'http-request', { method: 'POST', url: 'https://api.example/a', json: {}, auth: AUTH, redirects: 'follow' }).expect(200);
    expect(res.body.status).toBe(302);
    expect(calls.map((c) => c.url)).toEqual(['https://api.example/a']);
  });

  it('/info states the field', async () => {
    const { app } = setup();
    const res = await request(app).get('/info').set('authorization', `Bearer ${TOKEN}`).expect(200);
    expect(res.body.redirects).toEqual({ ops: ['fetch-url', 'evaluate-url', 'http-request'], values: ['follow', 'none'], default: 'follow' });
    expect(res.body.version).toBe('0.2.0');
  });
});
