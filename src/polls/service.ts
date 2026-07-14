/**
 * Poll-job lifecycle operations behind the /polls routes: creation
 * validation, status reads, cancellation (spec cor:web:030:01).
 *
 * Creation fails fast: the URL runs the full parse→resolve→validate guard
 * NOW so a forbidden target never becomes a job (the tick re-runs the guard
 * on every fetch regardless — nothing is trusted across ticks). The
 * credential is encrypted immediately and the plaintext never stored;
 * cancellation disposes of the ciphertext with the job (cor:web:030:02).
 *
 * The tool performs NO authorization here — orgId/appId are trusted
 * identifiers from core, which decided who may operate a watch.
 */

import { z } from 'zod';
import { ValidationError } from '../errors.js';
import { parseUrl, resolvePinned, type Resolver } from '../guard.js';
import { conditionsSchema, modeSchema, validateConditions } from '../evaluate.js';
import { authSchema, FETCH_URL_HEADER_ALLOWLIST, normalizeHeaders } from '../ops/index.js';
import type { CredentialCipher } from './crypto.js';
import type { NewPollJob, PollJob, PollStore } from './store.js';

export interface PollLimits {
  minIntervalSeconds: number;
  maxTtlDays: number;
  maxActivePerOrg: number;
}

export interface PollServiceDeps {
  store: PollStore;
  cipher: CredentialCipher;
  resolve: Resolver;
  limits: PollLimits;
  now(): Date;
}

export const createPollSchema = z
  .object({
    url: z.string().min(1).max(2_000),
    contentKind: z.enum(['auto', 'html', 'json']).default('auto'),
    conditions: conditionsSchema,
    mode: modeSchema,
    intervalSeconds: z.number().int().positive(),
    ttlSeconds: z.number().int().positive(),
    firePolicy: z.enum(['once', 'every_change', 'cooldown']).default('once'),
    cooldownSeconds: z.number().int().positive().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    auth: authSchema.optional(),
    orgId: z.string().min(1).max(128),
    appId: z.string().min(1).max(128).optional(),
    credentialsNodeUrn: z.string().max(512).optional(),
    urlPrefix: z.string().max(2_000).optional(),
  })
  .strict();

export type CreatePollInput = z.infer<typeof createPollSchema>;

/** The public job view — counters and lifecycle, never credential material. */
export interface PollJobView {
  jobId: string;
  orgId: string;
  appId: string | null;
  url: string;
  status: string;
  firePolicy: string;
  intervalSeconds: number;
  nextRunAt: string | null;
  expiresAt: string;
  lastCheckedAt: string | null;
  lastTriggeredAt: string | null;
  lastStatus: number | null;
  triggerCount: number;
  consecutiveFailures: number;
  hasCredential: boolean;
  createdAt: string;
}

export function toView(job: PollJob): PollJobView {
  return {
    jobId: job.id,
    orgId: job.orgId,
    appId: job.appId,
    url: job.url,
    status: job.status,
    firePolicy: job.firePolicy,
    intervalSeconds: job.intervalSeconds,
    nextRunAt: job.status === 'active' ? job.nextRunAt.toISOString() : null,
    expiresAt: job.expiresAt.toISOString(),
    lastCheckedAt: job.lastCheckedAt?.toISOString() ?? null,
    lastTriggeredAt: job.lastTriggeredAt?.toISOString() ?? null,
    lastStatus: job.lastStatus,
    triggerCount: job.triggerCount,
    consecutiveFailures: job.consecutiveFailures,
    hasCredential: job.authCiphertext !== null,
    createdAt: job.createdAt.toISOString(),
  };
}

export async function createPoll(deps: PollServiceDeps, raw: Record<string, unknown>): Promise<PollJobView> {
  const input = createPollSchema.parse(raw);
  validateConditions(input.conditions);

  const { limits } = deps;
  if (input.intervalSeconds < limits.minIntervalSeconds) {
    throw new ValidationError('intervalSeconds', `the interval floor is ${limits.minIntervalSeconds}s`);
  }
  if (input.ttlSeconds > limits.maxTtlDays * 86_400) {
    throw new ValidationError('ttlSeconds', `a poll may live at most ${limits.maxTtlDays} days`);
  }
  if (input.firePolicy === 'cooldown' && input.cooldownSeconds === undefined) {
    throw new ValidationError('cooldownSeconds', 'firePolicy "cooldown" requires cooldownSeconds');
  }

  const active = await deps.store.countActiveByOrg(input.orgId);
  if (active >= limits.maxActivePerOrg) {
    throw new ValidationError('orgId', `the organization already has ${active} active polls (cap ${limits.maxActivePerOrg})`);
  }

  // Fail fast: a forbidden target never becomes a job. Throws url_forbidden /
  // url_unresolvable / validation_error exactly like a one-shot fetch would.
  const parsed = parseUrl(input.url);
  await resolvePinned(parsed, deps.resolve);

  const now = deps.now();
  const job: NewPollJob = {
    orgId: input.orgId,
    appId: input.appId ?? null,
    url: input.url,
    contentKind: input.contentKind,
    conditions: input.conditions,
    mode: input.mode,
    // Same header policy as the read ops: content negotiation only, and the
    // credential/structural rejects apply (auth goes through the cipher).
    headers: normalizeHeaders(input.headers, FETCH_URL_HEADER_ALLOWLIST) ?? null,
    intervalSeconds: input.intervalSeconds,
    expiresAt: new Date(now.getTime() + input.ttlSeconds * 1_000),
    firePolicy: input.firePolicy,
    cooldownSeconds: input.cooldownSeconds ?? null,
    authCiphertext: input.auth ? deps.cipher.encrypt(input.auth) : null,
    authKeyId: input.auth ? deps.cipher.keyId : null,
    credentialsNodeUrn: input.credentialsNodeUrn ?? null,
    urlPrefix: input.urlPrefix ?? null,
    nextRunAt: now,
    status: 'active',
  };
  return toView(await deps.store.create(job));
}

export async function cancelPoll(deps: PollServiceDeps, id: string): Promise<PollJobView | null> {
  const job = await deps.store.get(id);
  if (!job) return null;
  if (job.status !== 'active') return toView(job);
  // The credential dies with the job (cor:web:030:02).
  const updated = await deps.store.update(id, { status: 'cancelled', authCiphertext: null, authKeyId: null });
  return updated ? toView(updated) : null;
}
