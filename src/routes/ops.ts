/**
 * Operations plane — POST /ops/<operation> (internal, bearer-gated).
 *
 * Every response is JSON. Errors use the typed catalog (src/errors.ts) —
 * hadron-server's webfetchClient passes the `error` code through verbatim.
 * There is no idempotency plane: the tool is stateless, so callers own
 * retry semantics (and must never auto-retry non-GET).
 */

import { Router, type Response } from 'express';
import { ZodError } from 'zod';
import { logger } from '../logger.js';
import { WebfetchToolError, validationFromZod } from '../errors.js';
import { OPERATIONS, runOperation } from '../ops/index.js';
import type { FetcherDeps } from '../fetcher.js';

function respondWithError(res: Response, err: unknown, opName: string): void {
  const typed = err instanceof ZodError ? validationFromZod(err) : err;
  if (typed instanceof WebfetchToolError) {
    res.status(typed.httpStatus).json(typed.toBody());
    return;
  }
  // Log the error class + a short message only — never inputs, headers, or
  // bodies (operation inputs carry caller-supplied credentials).
  logger.error('operation failed', {
    op: opName,
    err: String((typed as Error)?.message ?? typed).slice(0, 200),
  });
  res.status(500).json({ error: 'internal_error', message: 'Unexpected error.' });
}

/** Build the /ops router over injected fetcher deps (tests inject fakes). */
export function opsRouter(deps: FetcherDeps): Router {
  const router = Router();

  router.post('/:operation', async (req, res) => {
    const name = req.params.operation;
    if (!OPERATIONS[name]) {
      res.status(404).json({
        error: 'unknown_operation',
        message: `No operation "${name}"`,
        operations: Object.keys(OPERATIONS),
      });
      return;
    }
    try {
      const result = await runOperation(deps, name, (req.body ?? {}) as Record<string, unknown>);
      res.status(200).json({ ok: true, ...(result as Record<string, unknown>) });
    } catch (err) {
      respondWithError(res, err, name);
    }
  });

  return router;
}
