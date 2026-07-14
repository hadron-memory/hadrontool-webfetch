import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { config, VERSION } from './config.js';
import { logger } from './logger.js';
import { requireAuth } from './middleware/auth.js';
import { healthRouter } from './routes/health.js';
import { opsRouter } from './routes/ops.js';
import { pollsRouter } from './routes/polls.js';
import { OPERATIONS } from './ops/index.js';
import { defaultDeps, type FetcherDeps } from './fetcher.js';
import type { PollServiceDeps } from './polls/service.js';
import type { SchedulerDeps } from './polls/scheduler.js';

export interface AppOptions {
  /** Injectable fetch seams — tests pass fakes; production uses defaults. */
  fetcherDeps?: FetcherDeps;
  /** Override the bearer token (tests); defaults to config. */
  serviceToken?: string;
  /** Polling plane (spec cor:web:030) — mounted only when provided. */
  polls?: { service: PollServiceDeps; scheduler: SchedulerDeps };
}

/**
 * Build the Express app. Exported separately from the server bootstrap so
 * tests can exercise it with supertest without binding a port.
 */
export function createApp(options: AppOptions = {}): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '6mb' }));

  app.use(healthRouter);

  const auth = requireAuth(options.serviceToken ?? config.serviceToken);

  app.get('/info', auth, (_req, res) => {
    res.json({ name: 'hadrontool-webfetch', version: VERSION, operations: Object.keys(OPERATIONS) });
  });

  app.use('/ops', auth, opsRouter(options.fetcherDeps ?? defaultDeps));

  if (options.polls) {
    app.use('/polls', auth, pollsRouter(options.polls.service, options.polls.scheduler));
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    // Body-parser raise (e.g. payload too large / malformed JSON) carries a status.
    const status =
      (err as { status?: number })?.status ?? (err as { statusCode?: number })?.statusCode;
    if (typeof status === 'number') {
      res.status(status).json({ error: 'bad_request', message: (err as Error).message });
      return;
    }
    logger.error('unhandled error', { err: String((err as Error)?.message ?? err).slice(0, 200), path: req.path });
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
