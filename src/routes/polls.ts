/**
 * Polling plane — /polls (internal, bearer-gated; spec cor:web:030).
 *
 * Job CRUD for core's web_poll_* run tools. The tool performs NO
 * authorization (orgId/appId are core-trusted identifiers) and no response
 * ever carries credential material. POST /polls/:id/run forces one tick —
 * a testing/e2e convenience on the same code path the scheduler uses.
 */

import { Router, type Response } from 'express';
import { ZodError } from 'zod';
import { logger } from '../logger.js';
import { validationFromZod, WebfetchToolError } from '../errors.js';
import { cancelPoll, createPoll, toView, type PollServiceDeps } from '../polls/service.js';
import { tick, type SchedulerDeps } from '../polls/scheduler.js';

function respondWithError(res: Response, err: unknown, where: string): void {
  const typed = err instanceof ZodError ? validationFromZod(err) : err;
  if (typed instanceof WebfetchToolError) {
    res.status(typed.httpStatus).json(typed.toBody());
    return;
  }
  // Never log inputs — poll creation carries caller-supplied credentials.
  logger.error('polls route failed', { where, err: String((typed as Error)?.message ?? typed).slice(0, 200) });
  res.status(500).json({ error: 'internal_error', message: 'Unexpected error.' });
}

export function pollsRouter(service: PollServiceDeps, scheduler: SchedulerDeps): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    try {
      const view = await createPoll(service, (req.body ?? {}) as Record<string, unknown>);
      res.status(201).json({ ok: true, job: view });
    } catch (err) {
      respondWithError(res, err, 'create');
    }
  });

  router.get('/', async (req, res) => {
    const orgId = typeof req.query.orgId === 'string' ? req.query.orgId : '';
    if (!orgId) {
      res.status(400).json({ error: 'validation_error', field: 'orgId', reason: 'orgId is required' });
      return;
    }
    try {
      const jobs = await service.store.listByOrg(orgId);
      res.json({ ok: true, jobs: jobs.map(toView) });
    } catch (err) {
      respondWithError(res, err, 'list');
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const job = await service.store.get(req.params.id);
      if (!job) {
        res.status(404).json({ error: 'not_found', message: 'No such poll job.' });
        return;
      }
      res.json({ ok: true, job: toView(job) });
    } catch (err) {
      respondWithError(res, err, 'get');
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const view = await cancelPoll(service, req.params.id);
      if (!view) {
        res.status(404).json({ error: 'not_found', message: 'No such poll job.' });
        return;
      }
      res.json({ ok: true, job: view });
    } catch (err) {
      respondWithError(res, err, 'cancel');
    }
  });

  router.post('/:id/run', async (req, res) => {
    try {
      const job = await service.store.get(req.params.id);
      if (!job) {
        res.status(404).json({ error: 'not_found', message: 'No such poll job.' });
        return;
      }
      if (job.status !== 'active') {
        res.status(409).json({ error: 'poll_not_active', message: `Job is ${job.status}.` });
        return;
      }
      // Claim through the same lease the scheduler uses — a forced run must
      // never tick a job the loop is concurrently processing.
      const claimed = await service.store.claimOne(job.id, scheduler.now(), 60_000);
      if (!claimed) {
        res.status(409).json({ error: 'poll_leased', message: 'The scheduler is currently processing this job.' });
        return;
      }
      await tick(scheduler, claimed);
      const after = await service.store.get(req.params.id);
      res.json({ ok: true, job: after ? toView(after) : null });
    } catch (err) {
      respondWithError(res, err, 'run');
    }
  });

  return router;
}
