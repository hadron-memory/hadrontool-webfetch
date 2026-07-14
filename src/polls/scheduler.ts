/**
 * The polling scheduler: claim due jobs (lease-based, replica-safe) and run
 * one tick each (spec cor:web:030:01/:03).
 *
 * Tick order and the load-bearing invariants:
 *   1. Expiry first — an expired job attempts its poll.expired event and
 *      only transitions once core accepted it (a watch never silently ends).
 *   2. Decrypt the credential (the ONLY decrypt site, cor:web:030:02).
 *   3. Fetch through the full guard — resolve/validate/pin re-run EVERY
 *      tick; nothing is trusted across ticks.
 *   4. Evaluate against the stored baseline (first tick: baseline is
 *      recorded, changed-conditions don't fire).
 *   5. Fire policy gates the trigger; delivery happens BEFORE any state
 *      advance — baseline/lastNotifiedHash move only on accepted delivery
 *      (at-least-once; core dedupes).
 *   6. Failures (fetch, eval, delivery) back off exponentially; at the
 *      failure limit the job terminates with a best-effort poll.failed.
 */

import { htmlToText } from '../convert.js';
import { evaluateConditions, requiredKind, type ContentKind, type EvaluationOutcome } from '../evaluate.js';
import { UnsupportedContentTypeError, WebfetchToolError } from '../errors.js';
import { DEFAULT_MAX_BYTES, performFetch, type FetcherDeps, type FetchOutcome } from '../fetcher.js';
import { logger } from '../logger.js';
import type { CredentialCipher } from './crypto.js';
import type { EventForwarder, PollEvent } from './forwarder.js';
import type { PollJob, PollJobPatch, PollStore } from './store.js';

const MAX_BACKOFF_SECONDS = 3_600;
const MAX_EXCERPT_CHARS = 2_000;
const JITTER_FRACTION = 0.1;
const CLAIM_LEASE_MS = 60_000;
const CLAIM_BATCH = 10;

export interface SchedulerDeps {
  store: PollStore;
  fetcherDeps: FetcherDeps;
  cipher: CredentialCipher;
  forward: EventForwarder;
  failureLimit: number;
  now(): Date;
  /** Jitter source, injectable for tests. Returns [0,1). */
  random?(): number;
}

/** Claim and tick every currently-due job once. Returns the jobs ticked. */
export async function runDueOnce(deps: SchedulerDeps): Promise<number> {
  let total = 0;
  for (;;) {
    const claimed = await deps.store.claimDue(deps.now(), CLAIM_LEASE_MS, CLAIM_BATCH);
    if (claimed.length === 0) return total;
    for (const job of claimed) {
      total += 1;
      try {
        await tick(deps, job);
      } catch (err) {
        // A tick must never kill the loop; the job's own backoff state was
        // already advanced (or will be retried when its lease lapses).
        logger.error('poll tick failed', {
          jobId: job.id,
          err: String((err as Error)?.message ?? err).slice(0, 200),
        });
      }
    }
  }
}

/** Start the loop; returns a stop function. */
export function startScheduler(deps: SchedulerDeps, everyMs = 5_000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // never overlap loop iterations
    running = true;
    try {
      await runDueOnce(deps);
    } finally {
      running = false;
    }
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** One evaluation of one claimed job. */
export async function tick(deps: SchedulerDeps, job: PollJob): Promise<void> {
  const now = deps.now();

  // 1. Expiry — no fetch, just the terminal event, retried until accepted.
  if (job.expiresAt.getTime() <= now.getTime()) {
    await terminate(deps, job, 'expired', { kind: 'poll.expired' });
    return;
  }

  let outcome: FetchOutcome;
  let evaluation: EvaluationOutcome;
  try {
    // 2.–3. Decrypt + guarded fetch (full guard re-run, spec cor:web:030:00).
    const auth =
      job.authCiphertext !== null && job.authKeyId !== null
        ? deps.cipher.decrypt(job.authCiphertext, job.authKeyId)
        : undefined;
    outcome = await performFetch(
      {
        method: 'GET',
        url: job.url,
        headers: job.headers ?? undefined,
        auth,
        maxBytes: DEFAULT_MAX_BYTES,
        followRedirects: true,
      },
      deps.fetcherDeps,
    );
    // 4. Evaluate — same kind resolution as the evaluate-url op.
    evaluation = evaluateConditions({
      conditions: job.conditions,
      mode: job.mode,
      kind: resolveKind(job, outcome.contentType),
      bodyText: outcome.bodyText ?? '',
      baseline:
        job.baselineHash !== null || job.baselineValues !== null
          ? { hash: job.baselineHash ?? undefined, values: job.baselineValues ?? undefined }
          : undefined,
    });
  } catch (err) {
    await recordFailure(deps, job, err);
    return;
  }

  const base: PollJobPatch = {
    lastCheckedAt: now,
    lastStatus: outcome.status,
    consecutiveFailures: 0,
    nextRunAt: nextRun(deps, job, now),
    leaseUntil: null,
  };

  // First observation initializes the baseline (record, don't treat the
  // recording itself as state to notify about). Spec: cor:web:030:01.
  if (job.baselineHash === null) {
    base.baselineHash = evaluation.snapshot.hash;
    base.baselineValues = evaluation.snapshot.values;
  }

  // 5. Fire policy gate.
  if (evaluation.triggered && shouldFire(job, evaluation, now)) {
    const event: PollEvent = {
      kind: 'poll.triggered',
      jobId: job.id,
      orgId: job.orgId,
      appId: job.appId,
      url: job.url,
      finalUrl: outcome.finalUrl,
      status: outcome.status,
      matched: evaluation.results.filter((r) => r.matched).map(({ id, actual }) => ({ id, actual })),
      snapshotHash: evaluation.snapshot.hash,
      excerpt: excerptOf(outcome),
      source: 'external',
      triggerCount: job.triggerCount + 1,
      firedAt: now.toISOString(),
    };
    try {
      await deps.forward(event);
    } catch (err) {
      // NOT delivered: advance nothing notify-related; back off and retry.
      await recordFailure(deps, job, err);
      return;
    }
    // Delivered: NOW the baseline advances (advance-after-acceptance).
    await deps.store.update(job.id, {
      ...base,
      baselineHash: evaluation.snapshot.hash,
      baselineValues: evaluation.snapshot.values,
      lastNotifiedHash: evaluation.snapshot.hash,
      lastTriggeredAt: now,
      triggerCount: job.triggerCount + 1,
      ...(job.firePolicy === 'once' ? { status: 'done' as const, authCiphertext: null, authKeyId: null } : {}),
    });
    return;
  }

  await deps.store.update(job.id, base);
}

function resolveKind(job: PollJob, contentType: string | null): ContentKind {
  if (job.contentKind !== 'auto') return job.contentKind;
  const ct = contentType ?? '';
  const kind: ContentKind = ct === 'application/json' || ct.endsWith('+json') ? 'json' : 'html';
  const forced = requiredKind(job.conditions);
  if (forced !== undefined && forced !== kind) throw new UnsupportedContentTypeError(ct || 'unknown');
  return kind;
}

/** Edge-triggered re-fire semantics per fire policy (spec cor:web:030:01). */
function shouldFire(job: PollJob, evaluation: EvaluationOutcome, now: Date): boolean {
  if (job.lastNotifiedHash === null) return true; // never notified yet
  switch (job.firePolicy) {
    case 'once':
      return true; // a delivered once-trigger sets status=done; being here means it never delivered
    case 'every_change':
      return evaluation.snapshot.hash !== job.lastNotifiedHash;
    case 'cooldown': {
      const since = job.lastTriggeredAt ? now.getTime() - job.lastTriggeredAt.getTime() : Infinity;
      return since >= (job.cooldownSeconds ?? 0) * 1_000;
    }
  }
}

function excerptOf(outcome: FetchOutcome): string {
  const body = outcome.bodyText ?? '';
  const isHtml = outcome.contentType === 'text/html' || outcome.contentType === 'application/xhtml+xml';
  return (isHtml ? htmlToText(body) : body).slice(0, MAX_EXCERPT_CHARS);
}

function nextRun(deps: SchedulerDeps, job: PollJob, now: Date): Date {
  const jitter = 1 + (deps.random?.() ?? Math.random()) * JITTER_FRACTION;
  return new Date(now.getTime() + Math.round(job.intervalSeconds * 1_000 * jitter));
}

/** Backoff + failure limit; the limit terminates with a best-effort poll.failed. */
async function recordFailure(deps: SchedulerDeps, job: PollJob, err: unknown): Promise<void> {
  const now = deps.now();
  const failures = job.consecutiveFailures + 1;
  const code = err instanceof WebfetchToolError ? err.code : 'internal_error';
  logger.warn('poll tick error', { jobId: job.id, code, failures });

  if (failures >= deps.failureLimit) {
    await terminate(deps, job, 'failed', { kind: 'poll.failed', errorCode: code }, /* bestEffort */ true);
    return;
  }
  const backoffSeconds = Math.min(job.intervalSeconds * 2 ** failures, MAX_BACKOFF_SECONDS);
  await deps.store.update(job.id, {
    lastCheckedAt: now,
    consecutiveFailures: failures,
    nextRunAt: new Date(now.getTime() + backoffSeconds * 1_000),
    leaseUntil: null,
  });
}

/**
 * Terminal transition with its event. Non-best-effort (expiry): the status
 * only moves once core accepted the event — otherwise back off and retry the
 * delivery next tick. Best-effort (failure limit): the job terminates even
 * if the event can't be delivered — core has been unreachable for the whole
 * failure run, and looping forever would poll a dead job indefinitely.
 */
async function terminate(
  deps: SchedulerDeps,
  job: PollJob,
  status: 'expired' | 'failed',
  event: Pick<PollEvent, 'kind'> & Partial<PollEvent>,
  bestEffort = false,
): Promise<void> {
  const now = deps.now();
  try {
    await deps.forward({
      jobId: job.id,
      orgId: job.orgId,
      appId: job.appId,
      url: job.url,
      source: 'external',
      triggerCount: job.triggerCount,
      firedAt: now.toISOString(),
      ...event,
    } as PollEvent);
  } catch (err) {
    if (!bestEffort) {
      await recordFailure(deps, job, err);
      return;
    }
    logger.error('terminal poll event undeliverable', {
      jobId: job.id,
      kind: event.kind,
      err: String((err as Error)?.message ?? err).slice(0, 200),
    });
  }
  // The credential dies with the job (cor:web:030:02).
  await deps.store.update(job.id, { status, authCiphertext: null, authKeyId: null, leaseUntil: null });
}
