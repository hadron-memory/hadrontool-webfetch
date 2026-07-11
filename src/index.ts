import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';

const app = createApp();

app.listen(config.port, () => {
  logger.info('hadrontool-webfetch listening', {
    port: config.port,
    nodeEnv: config.nodeEnv,
    authEnabled: Boolean(config.serviceToken),
  });
});
