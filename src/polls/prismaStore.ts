/**
 * Postgres/Prisma implementation of the PollStore seam (production; the
 * test suite runs the in-memory implementation).
 *
 * `claimDue` is one atomic statement — UPDATE … WHERE id IN (SELECT …
 * FOR UPDATE SKIP LOCKED) RETURNING — so concurrent replicas never claim
 * the same job (spec cor:web:030:01: lease-based claiming).
 */

import { Prisma, PrismaClient } from '@prisma/client';
import type { Baseline, Condition } from '../evaluate.js';
import type { NewPollJob, PollJob, PollJobPatch, PollStatus, PollStore } from './store.js';

type Row = Prisma.WebFetchPollJobGetPayload<Record<string, never>>;

function toDomain(row: Row): PollJob {
  return {
    id: row.id,
    orgId: row.orgId,
    appId: row.appId,
    url: row.url,
    contentKind: row.contentKind as PollJob['contentKind'],
    conditions: row.conditions as unknown as Condition[],
    mode: row.mode as PollJob['mode'],
    headers: (row.headersJson as Record<string, string> | null) ?? null,
    intervalSeconds: row.intervalSeconds,
    expiresAt: row.expiresAt,
    firePolicy: row.firePolicy as PollJob['firePolicy'],
    cooldownSeconds: row.cooldownSeconds,
    authCiphertext: row.authCiphertext,
    authKeyId: row.authKeyId,
    credentialsNodeUrn: row.credentialsNodeUrn,
    urlPrefix: row.urlPrefix,
    baselineHash: row.baselineHash,
    baselineValues: (row.baselineValues as Baseline['values'] | null) ?? null,
    lastNotifiedHash: row.lastNotifiedHash,
    lastStatus: row.lastStatus,
    lastCheckedAt: row.lastCheckedAt,
    lastTriggeredAt: row.lastTriggeredAt,
    triggerCount: row.triggerCount,
    consecutiveFailures: row.consecutiveFailures,
    nextRunAt: row.nextRunAt,
    leaseUntil: row.leaseUntil,
    status: row.status as PollStatus,
    createdAt: row.createdAt,
  };
}

/** Json columns: undefined = leave untouched; objects pass through. */
function json(value: unknown): Prisma.InputJsonValue | undefined {
  return value === undefined || value === null ? undefined : (value as Prisma.InputJsonValue);
}

export class PrismaPollStore implements PollStore {
  constructor(private readonly prisma: PrismaClient = new PrismaClient()) {}

  async create(job: NewPollJob): Promise<PollJob> {
    const row = await this.prisma.webFetchPollJob.create({
      data: {
        orgId: job.orgId,
        appId: job.appId,
        url: job.url,
        contentKind: job.contentKind,
        conditions: job.conditions as unknown as Prisma.InputJsonValue,
        mode: job.mode,
        headersJson: json(job.headers),
        intervalSeconds: job.intervalSeconds,
        expiresAt: job.expiresAt,
        firePolicy: job.firePolicy,
        cooldownSeconds: job.cooldownSeconds,
        authCiphertext: job.authCiphertext,
        authKeyId: job.authKeyId,
        credentialsNodeUrn: job.credentialsNodeUrn,
        urlPrefix: job.urlPrefix,
        nextRunAt: job.nextRunAt,
        status: job.status,
      },
    });
    return toDomain(row);
  }

  async get(id: string): Promise<PollJob | null> {
    const row = await this.prisma.webFetchPollJob.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async listByOrg(orgId: string): Promise<PollJob[]> {
    const rows = await this.prisma.webFetchPollJob.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' } });
    return rows.map(toDomain);
  }

  async countActiveByOrg(orgId: string): Promise<number> {
    return this.prisma.webFetchPollJob.count({ where: { orgId, status: 'active' } });
  }

  async update(id: string, patch: PollJobPatch): Promise<PollJob | null> {
    const { baselineValues, ...scalars } = patch;
    try {
      const row = await this.prisma.webFetchPollJob.update({
        where: { id },
        data: {
          ...scalars,
          ...(baselineValues !== undefined ? { baselineValues: json(baselineValues) ?? Prisma.DbNull } : {}),
        },
      });
      return toDomain(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') return null;
      throw err;
    }
  }

  async claimDue(now: Date, leaseMs: number, limit: number): Promise<PollJob[]> {
    const lease = new Date(now.getTime() + leaseMs);
    const claimed = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "WebFetchPollJob"
      SET "leaseUntil" = ${lease}, "updatedAt" = now()
      WHERE id IN (
        SELECT id FROM "WebFetchPollJob"
        WHERE status = 'active'
          AND "nextRunAt" <= ${now}
          AND ("leaseUntil" IS NULL OR "leaseUntil" < ${now})
        ORDER BY "nextRunAt"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `;
    if (claimed.length === 0) return [];
    const rows = await this.prisma.webFetchPollJob.findMany({ where: { id: { in: claimed.map((r) => r.id) } } });
    return rows.map(toDomain);
  }
}
