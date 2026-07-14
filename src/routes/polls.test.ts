/**
 * /polls plane tests: creation validation (floor/TTL/cap/guard fail-fast),
 * the no-credential-on-any-read-surface guarantee, cancellation disposal,
 * and the forced-tick endpoint. Supertest over the in-memory store.
 */

import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import type { FetcherDeps, HopInit, HopResponse } from '../fetcher.js';
import { createCredentialCipher } from '../polls/crypto.js';
import type { PollEvent } from '../polls/forwarder.js';
import type { SchedulerDeps } from '../polls/scheduler.js';
import type { PollServiceDeps } from '../polls/service.js';
import { InMemoryPollStore } from '../polls/store.js';

const TOKEN = 'test-token';
const KEY = 'b'.repeat(64);

function pollsApp(options: { hosts?: Record<string, string[]>; respond?: (url: string, init: HopInit) => HopResponse } = {}) {
  const store = new InMemoryPollStore();
  const cipher = createCredentialCipher(KEY);
  const events: PollEvent[] = [];
  const fetcherDeps: FetcherDeps = {
    resolve: async (hostname) =>
      (options.hosts?.[hostname] ?? ['93.184.216.34']).map((address) => ({ address, family: 4 })),
    dispatcherFor: () => ({ dispatcher: {}, close: async () => {} }),
    fetchImpl: async (url, init) =>
      options.respond?.(url, init) ??
      (new Response('<html><body>ok</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }) as unknown as HopResponse),
  };
  const service: PollServiceDeps = {
    store,
    cipher,
    resolve: fetcherDeps.resolve,
    limits: { minIntervalSeconds: 60, maxTtlDays: 30, maxActivePerOrg: 2 },
    now: () => new Date('2026-07-14T12:00:00Z'),
  };
  const scheduler: SchedulerDeps = {
    store,
    fetcherDeps,
    cipher,
    forward: async (e) => {
      events.push(e);
    },
    failureLimit: 3,
    now: () => new Date('2026-07-14T12:00:00Z'),
    random: () => 0,
  };
  const app = createApp({ fetcherDeps, serviceToken: TOKEN, polls: { service, scheduler } });
  return { app, store, events };
}

const CREATE = {
  url: 'https://example.com/page',
  conditions: [{ id: 'w', type: 'content_changed' }],
  intervalSeconds: 60,
  ttlSeconds: 3_600,
  orgId: 'org-1',
};

const post = (a: ReturnType<typeof pollsApp>['app'], path: string, body?: unknown) =>
  request(a).post(path).set('authorization', `Bearer ${TOKEN}`).send(body as object);

describe('POST /polls', () => {
  it('creates a job and returns the view without credential material', async () => {
    const { app } = pollsApp();
    const res = await post(app, '/polls', {
      ...CREATE,
      auth: { type: 'bearer', token: 'super-sekrit' },
    }).expect(201);
    expect(res.body.jobId).toBeTruthy();
    expect(res.body.status).toBe('active');
    expect(res.body.hasCredential).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('super-sekrit');
  });

  it('enforces the interval floor, TTL cap, and per-org cap', async () => {
    const { app } = pollsApp();
    let res = await post(app, '/polls', { ...CREATE, intervalSeconds: 5 }).expect(400);
    expect(res.body.reason).toContain('interval floor');
    res = await post(app, '/polls', { ...CREATE, ttlSeconds: 999 * 86_400 }).expect(400);
    expect(res.body.reason).toContain('30 days');
    await post(app, '/polls', CREATE).expect(201);
    await post(app, '/polls', CREATE).expect(201);
    res = await post(app, '/polls', CREATE).expect(400); // cap = 2, enforced atomically in the store
    expect(res.body.reason).toContain('cap of 2');
  });

  it('rejects an explicit contentKind that conflicts with the conditions', async () => {
    const { app } = pollsApp();
    const res = await post(app, '/polls', {
      ...CREATE,
      contentKind: 'json',
      conditions: [{ id: 's', type: 'selector_exists', selector: 'h1' }],
    }).expect(400);
    expect(res.body.field).toBe('contentKind');
  });

  it('refuses a guard-forbidden target at creation (fail fast)', async () => {
    const { app, store } = pollsApp({ hosts: { 'internal.example': ['10.0.0.9'] } });
    const res = await post(app, '/polls', { ...CREATE, url: 'https://internal.example/' }).expect(403);
    expect(res.body.error).toBe('url_forbidden');
    expect(await store.countActiveByOrg('org-1')).toBe(0); // never became a job
  });

  it('rejects credential-carrying plain headers (auth channel only)', async () => {
    const { app } = pollsApp();
    const res = await post(app, '/polls', { ...CREATE, headers: { cookie: 'sid=1' } }).expect(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('requires cooldownSeconds for the cooldown policy', async () => {
    const { app } = pollsApp();
    const res = await post(app, '/polls', { ...CREATE, firePolicy: 'cooldown' }).expect(400);
    expect(res.body.field).toBe('cooldownSeconds');
  });
});

describe('read, cancel, run', () => {
  it('lists by org and 404s unknown jobs', async () => {
    const { app } = pollsApp();
    await post(app, '/polls', CREATE).expect(201);
    const list = await request(app).get('/polls?orgId=org-1').set('authorization', `Bearer ${TOKEN}`).expect(200);
    expect(list.body.jobs).toHaveLength(1);
    await request(app).get('/polls/nope').set('authorization', `Bearer ${TOKEN}`).expect(404);
  });

  it('cancel disposes of the stored credential', async () => {
    const { app, store } = pollsApp();
    const created = await post(app, '/polls', { ...CREATE, auth: { type: 'bearer', token: 't0k' } }).expect(201);
    const id = created.body.jobId;
    expect((await store.get(id))!.authCiphertext).not.toBeNull();
    const res = await request(app).delete(`/polls/${id}`).set('authorization', `Bearer ${TOKEN}`).expect(200);
    expect(res.body.status).toBe('cancelled');
    expect((await store.get(id))!.authCiphertext).toBeNull();
  });

  it('POST /polls/:id/run forces a tick on the scheduler code path', async () => {
    const { app } = pollsApp();
    const created = await post(app, '/polls', CREATE).expect(201);
    const id = created.body.jobId;
    const res = await post(app, `/polls/${id}/run`).expect(200);
    expect(res.body.lastCheckedAt).not.toBeNull();
    expect(res.body.lastStatus).toBe(200);
  });

  it('POST /polls/:id/run 409s while the scheduler holds the lease', async () => {
    const { app, store } = pollsApp();
    const created = await post(app, '/polls', CREATE).expect(201);
    const id = created.body.jobId;
    await store.update(id, { leaseUntil: new Date('2026-07-14T12:00:30Z') }); // scheduler mid-tick
    const res = await post(app, `/polls/${id}/run`).expect(409);
    expect(res.body.error).toBe('poll_leased');
  });

  it('the polls plane is absent when not configured', async () => {
    const app = createApp({ serviceToken: TOKEN });
    await post(app, '/polls', CREATE).expect(404);
  });
});
