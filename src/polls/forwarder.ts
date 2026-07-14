/**
 * Tool→core event forwarder (spec cor:web:030:03). One-way, outbound only.
 *
 * THROWS on any delivery failure — a log-and-swallow forwarder would defeat
 * the retry mechanism entirely (the gmail event-plane invariant): the tick
 * advances its baseline only after this returns, so a throw leaves the job
 * state untouched and the event is re-attempted next tick (at-least-once;
 * core dedupes on jobId + snapshotHash + kind).
 */

import type { ConditionResult } from '../evaluate.js';

export interface PollEvent {
  kind: 'poll.triggered' | 'poll.expired' | 'poll.failed';
  jobId: string;
  orgId: string;
  appId: string | null;
  url: string;
  finalUrl?: string;
  status?: number;
  matched?: Pick<ConditionResult, 'id' | 'actual'>[];
  snapshotHash?: string;
  /** Capped extract of the observed content — untrusted external material. */
  excerpt?: string;
  source: 'external';
  triggerCount: number;
  firedAt: string;
  /** poll.failed only: the stable error code of the terminal failure. */
  errorCode?: string;
}

export type EventForwarder = (event: PollEvent) => Promise<void>;

export class EventDeliveryError extends Error {
  constructor(detail: string) {
    super(`poll event delivery failed: ${detail}`);
  }
}

export interface ForwarderOptions {
  coreEventsUrl: string;
  coreEventsToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** HTTP forwarder to core's ingress. 2xx = durably accepted; anything else throws. */
export function createEventForwarder(options: ForwarderOptions): EventForwarder {
  const { coreEventsUrl, coreEventsToken, timeoutMs = 10_000, fetchImpl = fetch } = options;
  return async (event) => {
    let response: Response;
    try {
      response = await fetchImpl(coreEventsUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(coreEventsToken ? { authorization: `Bearer ${coreEventsToken}` } : {}),
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new EventDeliveryError(String((err as Error)?.message ?? err).slice(0, 200));
    }
    // Drain the body (even on errors) so undici returns the socket to the pool.
    await response.text().catch(() => {});
    if (response.status < 200 || response.status >= 300) {
      throw new EventDeliveryError(`core responded ${response.status}`);
    }
  };
}
