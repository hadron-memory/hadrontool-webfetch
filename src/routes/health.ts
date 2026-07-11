import { Router } from 'express';

export const healthRouter = Router();

/** Liveness — the process is up and the event loop is responsive. */
healthRouter.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

/** Readiness — stateless service: alive ⇒ ready. */
healthRouter.get('/readyz', (_req, res) => {
  res.json({ status: 'ok' });
});
