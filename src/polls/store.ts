/**
 * The poll-job store seam. The scheduler and routes work against this
 * interface; production binds the Prisma/Postgres implementation, the test
 * suite an in-memory one (the repo's fake-seams testing convention — no DB
 * in the suite, like no network in the fetcher tests).
 *
 * Claiming uses a lease: `claimDue` atomically stamps `leaseUntil` on due
 * jobs so a second replica never double-ticks one (spec cor:web:030:01).
 */

import type { Baseline, Condition } from '../evaluate.js';

export type PollStatus = 'active' | 'done' | 'expired' | 'failed' | 'cancelled';
export type FirePolicy = 'once' | 'every_change' | 'cooldown';

export interface PollJob {
  id: string;
  orgId: string;
  appId: string | null;
  url: string;
  contentKind: 'html' | 'json' | 'auto';
  conditions: Condition[];
  mode: 'any' | 'all';
  headers: Record<string, string> | null;
  intervalSeconds: number;
  expiresAt: Date;
  firePolicy: FirePolicy;
  cooldownSeconds: number | null;
  authCiphertext: string | null;
  authKeyId: string | null;
  credentialsNodeUrn: string | null;
  urlPrefix: string | null;
  baselineHash: string | null;
  baselineValues: Baseline['values'] | null;
  lastNotifiedHash: string | null;
  lastStatus: number | null;
  lastCheckedAt: Date | null;
  lastTriggeredAt: Date | null;
  triggerCount: number;
  consecutiveFailures: number;
  nextRunAt: Date;
  leaseUntil: Date | null;
  status: PollStatus;
  createdAt: Date;
}

export type NewPollJob = Omit<
  PollJob,
  | 'id'
  | 'baselineHash'
  | 'baselineValues'
  | 'lastNotifiedHash'
  | 'lastStatus'
  | 'lastCheckedAt'
  | 'lastTriggeredAt'
  | 'triggerCount'
  | 'consecutiveFailures'
  | 'leaseUntil'
  | 'createdAt'
>;

/** Mutable tick/lifecycle state — everything a tick may advance. */
export type PollJobPatch = Partial<
  Pick<
    PollJob,
    | 'baselineHash'
    | 'baselineValues'
    | 'lastNotifiedHash'
    | 'lastStatus'
    | 'lastCheckedAt'
    | 'lastTriggeredAt'
    | 'triggerCount'
    | 'consecutiveFailures'
    | 'nextRunAt'
    | 'leaseUntil'
    | 'status'
    | 'authCiphertext'
    | 'authKeyId'
  >
>;

export interface PollStore {
  create(job: NewPollJob): Promise<PollJob>;
  /**
   * Create iff the org is under `maxActive` active jobs — atomically, so
   * concurrent creations (or replicas) cannot overshoot the cap. Returns
   * null when the cap is hit.
   */
  createCapped(job: NewPollJob, maxActive: number): Promise<PollJob | null>;
  get(id: string): Promise<PollJob | null>;
  /** Most recent first; implementations cap the result (currently 100). */
  listByOrg(orgId: string): Promise<PollJob[]>;
  countActiveByOrg(orgId: string): Promise<number>;
  update(id: string, patch: PollJobPatch): Promise<PollJob | null>;
  /**
   * Atomically claim up to `limit` due jobs: status=active, nextRunAt<=now,
   * lease absent or expired. Claimed jobs get leaseUntil=now+leaseMs and are
   * returned; concurrent claimers never receive the same job.
   */
  claimDue(now: Date, leaseMs: number, limit: number): Promise<PollJob[]>;
  /**
   * Atomically claim ONE job regardless of nextRunAt (the forced-run path):
   * succeeds iff the job is active and not currently leased. Null = missing,
   * not active, or leased — the caller distinguishes via get().
   */
  claimOne(id: string, now: Date, leaseMs: number): Promise<PollJob | null>;
}

/** In-memory store for the test suite (and dev without a database). */
export class InMemoryPollStore implements PollStore {
  private jobs = new Map<string, PollJob>();
  private seq = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(job: NewPollJob): Promise<PollJob> {
    const full: PollJob = {
      ...job,
      id: `job-${++this.seq}`,
      baselineHash: null,
      baselineValues: null,
      lastNotifiedHash: null,
      lastStatus: null,
      lastCheckedAt: null,
      lastTriggeredAt: null,
      triggerCount: 0,
      consecutiveFailures: 0,
      leaseUntil: null,
      createdAt: this.now(),
    };
    this.jobs.set(full.id, full);
    return { ...full };
  }

  async createCapped(job: NewPollJob, maxActive: number): Promise<PollJob | null> {
    // Single-threaded: count-then-insert is atomic by construction here.
    if ((await this.countActiveByOrg(job.orgId)) >= maxActive) return null;
    return this.create(job);
  }

  async get(id: string): Promise<PollJob | null> {
    const job = this.jobs.get(id);
    return job ? { ...job } : null;
  }

  async listByOrg(orgId: string): Promise<PollJob[]> {
    return [...this.jobs.values()].filter((j) => j.orgId === orgId).map((j) => ({ ...j }));
  }

  async countActiveByOrg(orgId: string): Promise<number> {
    return [...this.jobs.values()].filter((j) => j.orgId === orgId && j.status === 'active').length;
  }

  async update(id: string, patch: PollJobPatch): Promise<PollJob | null> {
    const job = this.jobs.get(id);
    if (!job) return null;
    Object.assign(job, patch);
    return { ...job };
  }

  async claimDue(now: Date, leaseMs: number, limit: number): Promise<PollJob[]> {
    const due = [...this.jobs.values()]
      .filter(
        (j) =>
          j.status === 'active' &&
          j.nextRunAt.getTime() <= now.getTime() &&
          (j.leaseUntil === null || j.leaseUntil.getTime() < now.getTime()),
      )
      .sort((a, b) => a.nextRunAt.getTime() - b.nextRunAt.getTime())
      .slice(0, limit);
    for (const j of due) j.leaseUntil = new Date(now.getTime() + leaseMs);
    return due.map((j) => ({ ...j }));
  }

  async claimOne(id: string, now: Date, leaseMs: number): Promise<PollJob | null> {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'active') return null;
    if (job.leaseUntil !== null && job.leaseUntil.getTime() >= now.getTime()) return null;
    job.leaseUntil = new Date(now.getTime() + leaseMs);
    return { ...job };
  }
}
