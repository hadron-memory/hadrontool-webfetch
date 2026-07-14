/**
 * Scheduler/tick tests over the in-memory store, fake fetch seams, a fake
 * clock, and a recording forwarder — the invariants of cor:web:030:01/:03:
 * first-observation baseline init, fire policies, advance-only-after-
 * delivery, backoff + failure limit, expiry-first, credential disposal.
 */

import { describe, expect, it } from 'vitest';
import type { FetcherDeps, HopInit, HopResponse } from '../fetcher.js';
import type { Condition } from '../evaluate.js';
import { createCredentialCipher } from './crypto.js';
import type { PollEvent } from './forwarder.js';
import { runDueOnce, tick, type SchedulerDeps } from './scheduler.js';
import { InMemoryPollStore, type NewPollJob } from './store.js';

const KEY = 'a'.repeat(64);

function fakeFetcher(respond: (url: string, init: HopInit) => HopResponse) {
  const calls: { url: string; init: HopInit }[] = [];
  const deps: FetcherDeps = {
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    dispatcherFor: () => ({ dispatcher: {}, close: async () => {} }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return respond(url, init);
    },
  };
  return { deps, calls };
}

function html(body: string): HopResponse {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } }) as unknown as HopResponse;
}

interface HarnessOptions {
  respond?: (url: string, init: HopInit) => HopResponse;
  deliver?: (event: PollEvent) => Promise<void>;
  failureLimit?: number;
}

function harness(options: HarnessOptions = {}) {
  const store = new InMemoryPollStore();
  const cipher = createCredentialCipher(KEY);
  const events: PollEvent[] = [];
  let nowMs = Date.parse('2026-07-14T12:00:00Z');
  const { deps: fetcherDeps, calls } = fakeFetcher(options.respond ?? (() => html('<html><body>hi</body></html>')));
  const deps: SchedulerDeps = {
    store,
    fetcherDeps,
    cipher,
    forward: async (event) => {
      if (options.deliver) await options.deliver(event);
      events.push(event);
    },
    failureLimit: options.failureLimit ?? 3,
    now: () => new Date(nowMs),
    random: () => 0, // no jitter in tests
  };
  const advance = (seconds: number) => {
    nowMs += seconds * 1_000;
  };
  const newJob = (over: Partial<NewPollJob> = {}): NewPollJob => ({
    orgId: 'org-1',
    appId: null,
    url: 'https://example.com/page',
    contentKind: 'auto',
    conditions: [{ id: 'w', type: 'content_changed' }] as Condition[],
    mode: 'any',
    headers: null,
    intervalSeconds: 60,
    expiresAt: new Date(nowMs + 86_400_000),
    firePolicy: 'every_change',
    cooldownSeconds: null,
    authCiphertext: null,
    authKeyId: null,
    credentialsNodeUrn: null,
    urlPrefix: null,
    nextRunAt: new Date(nowMs),
    status: 'active',
    ...over,
  });
  return { store, cipher, events, deps, advance, newJob, calls };
}

describe('first observation + edge-triggered firing', () => {
  it('initializes the baseline without firing, then fires on change, then stays quiet', async () => {
    let page = '<html><body>v1</body></html>';
    const h = harness({ respond: () => html(page) });
    const job = await h.store.create(h.newJob());

    await tick(h.deps, (await h.store.get(job.id))!);
    expect(h.events).toHaveLength(0); // first tick records, never fires
    expect((await h.store.get(job.id))!.baselineHash).toBeTruthy();

    h.advance(60);
    await tick(h.deps, (await h.store.get(job.id))!);
    expect(h.events).toHaveLength(0); // unchanged content

    page = '<html><body>v2</body></html>';
    h.advance(60);
    await tick(h.deps, (await h.store.get(job.id))!);
    expect(h.events).toHaveLength(1);
    expect(h.events[0].kind).toBe('poll.triggered');
    expect(h.events[0].source).toBe('external');

    h.advance(60);
    await tick(h.deps, (await h.store.get(job.id))!);
    expect(h.events).toHaveLength(1); // same content as last notified — edge, no re-fire
  });

  it('an absolute condition may fire on the first tick; once → done + credential disposed', async () => {
    const h = harness({ respond: () => html('<html><body><b id="x">hit</b></body></html>') });
    const auth = h.cipher.encrypt({ type: 'bearer', token: 'secret-token' });
    const job = await h.store.create(
      h.newJob({
        conditions: [{ id: 's', type: 'selector_exists', selector: '#x' }] as Condition[],
        firePolicy: 'once',
        authCiphertext: auth,
        authKeyId: h.cipher.keyId,
      }),
    );
    await tick(h.deps, (await h.store.get(job.id))!);
    expect(h.events).toHaveLength(1);
    const after = (await h.store.get(job.id))!;
    expect(after.status).toBe('done');
    expect(after.authCiphertext).toBeNull(); // credential dies with the job
    // The credential was decrypted only into the fetch:
    expect(h.calls[0].init.headers['authorization']).toBe('Bearer secret-token');
  });

  it('cooldown suppresses re-fires inside the window', async () => {
    let n = 0;
    const h = harness({ respond: () => html(`<html><body>v${n}</body></html>`) });
    const job = await h.store.create(h.newJob({ firePolicy: 'cooldown', cooldownSeconds: 300 }));

    await tick(h.deps, (await h.store.get(job.id))!); // baseline
    n = 1;
    h.advance(60);
    await tick(h.deps, (await h.store.get(job.id))!); // fires
    n = 2;
    h.advance(60);
    await tick(h.deps, (await h.store.get(job.id))!); // changed again but inside cooldown
    expect(h.events).toHaveLength(1);
    n = 3;
    h.advance(300);
    await tick(h.deps, (await h.store.get(job.id))!); // cooldown over
    expect(h.events).toHaveLength(2);
  });
});

describe('advance-only-after-delivery (at-least-once)', () => {
  it('keeps the baseline and retries when core rejects the event', async () => {
    let page = '<html><body>v1</body></html>';
    let coreUp = false;
    const h = harness({
      respond: () => html(page),
      deliver: async () => {
        if (!coreUp) throw new Error('core down');
      },
    });
    const job = await h.store.create(h.newJob());
    await tick(h.deps, (await h.store.get(job.id))!); // baseline
    const baseline = (await h.store.get(job.id))!.baselineHash;

    page = '<html><body>v2</body></html>';
    h.advance(60);
    await tick(h.deps, (await h.store.get(job.id))!); // trigger, delivery fails
    const failed = (await h.store.get(job.id))!;
    expect(h.events).toHaveLength(0);
    expect(failed.baselineHash).toBe(baseline); // NOT advanced
    expect(failed.consecutiveFailures).toBe(1); // backing off

    coreUp = true;
    h.advance(3_600);
    await tick(h.deps, (await h.store.get(job.id))!); // retried and delivered
    const ok = (await h.store.get(job.id))!;
    expect(h.events).toHaveLength(1);
    expect(ok.baselineHash).not.toBe(baseline);
    expect(ok.lastNotifiedHash).toBe(ok.baselineHash);
    expect(ok.consecutiveFailures).toBe(0);
  });
});

describe('failure handling', () => {
  it('backs off exponentially and terminates with poll.failed at the limit', async () => {
    const h = harness({
      respond: () => {
        throw new Error('connection refused');
      },
      failureLimit: 3,
    });
    const job = await h.store.create(h.newJob());

    await tick(h.deps, (await h.store.get(job.id))!);
    const one = (await h.store.get(job.id))!;
    expect(one.consecutiveFailures).toBe(1);
    expect(one.nextRunAt.getTime()).toBe(h.deps.now().getTime() + 120_000); // 60s·2^1

    await tick(h.deps, one);
    const two = (await h.store.get(job.id))!;
    expect(two.nextRunAt.getTime()).toBe(h.deps.now().getTime() + 240_000); // 60s·2^2

    await tick(h.deps, two); // hits the limit
    const dead = (await h.store.get(job.id))!;
    expect(dead.status).toBe('failed');
    expect(h.events).toHaveLength(1);
    expect(h.events[0].kind).toBe('poll.failed');
    expect(h.events[0].errorCode).toBe('fetch_failed');
  });
});

describe('expiry', () => {
  it('emits poll.expired and transitions only after core accepts it', async () => {
    let coreUp = false;
    const h = harness({
      deliver: async () => {
        if (!coreUp) throw new Error('core down');
      },
    });
    const job = await h.store.create(h.newJob({ expiresAt: new Date(h.deps.now().getTime() - 1_000) }));

    await tick(h.deps, (await h.store.get(job.id))!);
    expect((await h.store.get(job.id))!.status).toBe('active'); // not accepted → still retrying
    expect(h.events).toHaveLength(0);

    coreUp = true;
    await tick(h.deps, (await h.store.get(job.id))!);
    const done = (await h.store.get(job.id))!;
    expect(done.status).toBe('expired');
    expect(h.events.map((e) => e.kind)).toEqual(['poll.expired']);
    expect(h.calls).toHaveLength(0); // expiry never fetches
  });
});

describe('runDueOnce claiming', () => {
  it('ticks due jobs only, and a lease prevents double-claiming', async () => {
    const h = harness();
    const due = await h.store.create(h.newJob());
    await h.store.create(h.newJob({ nextRunAt: new Date(h.deps.now().getTime() + 60_000) }));

    const ticked = await runDueOnce(h.deps);
    expect(ticked).toBe(1);

    // The due job advanced its nextRunAt; nothing is claimable now.
    expect(await runDueOnce(h.deps)).toBe(0);
    expect((await h.store.get(due.id))!.lastCheckedAt).not.toBeNull();
  });
});
