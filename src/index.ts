import { createApp, type AppOptions } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { defaultDeps } from './fetcher.js';
import { createCredentialCipher } from './polls/crypto.js';
import { createEventForwarder } from './polls/forwarder.js';
import { PrismaPollStore } from './polls/prismaStore.js';
import { startScheduler, type SchedulerDeps } from './polls/scheduler.js';
import type { PollServiceDeps } from './polls/service.js';

// The polling plane boots only on its full env quorum (spec cor:web:030);
// otherwise the tool runs ops-only, exactly as before.
let polls: AppOptions['polls'];
let scheduler: SchedulerDeps | undefined;
if (config.polling.configured) {
  const store = new PrismaPollStore();
  const cipher = createCredentialCipher(config.polling.tokenEncryptionKey!);
  const forward = createEventForwarder({
    coreEventsUrl: config.polling.coreEventsUrl!,
    coreEventsToken: config.polling.coreEventsToken,
  });
  const now = () => new Date();
  const service: PollServiceDeps = {
    store,
    cipher,
    resolve: defaultDeps.resolve,
    limits: {
      minIntervalSeconds: config.polling.minIntervalSeconds,
      maxTtlDays: config.polling.maxTtlDays,
      maxActivePerOrg: config.polling.maxActivePerOrg,
    },
    now,
  };
  scheduler = { store, fetcherDeps: defaultDeps, cipher, forward, failureLimit: config.polling.failureLimit, now };
  polls = { service, scheduler };
}

const app = createApp({ polls });

app.listen(config.port, () => {
  logger.info('hadrontool-webfetch listening', {
    port: config.port,
    nodeEnv: config.nodeEnv,
    authEnabled: Boolean(config.serviceToken),
    pollingEnabled: Boolean(scheduler),
  });
  if (scheduler) startScheduler(scheduler);
});
