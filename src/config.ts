import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment configuration, validated once at boot. Importing this module
 * throws (and the process exits non-zero) if the environment is invalid, so a
 * misconfigured container fails fast instead of half-working.
 */
const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  WEBFETCH_TOOL_TOKEN: z.string().min(1).optional(),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

const env = parsed.data;
const isProduction = env.NODE_ENV === 'production';

// Refuse to run an unauthenticated fetch proxy in production — an open
// URL-fetching endpoint inside the private network is an SSRF foothold.
if (isProduction && !env.WEBFETCH_TOOL_TOKEN) {
  // eslint-disable-next-line no-console
  console.error('WEBFETCH_TOOL_TOKEN must be set when NODE_ENV=production. Refusing to start.');
  process.exit(1);
}

export const VERSION = '0.1.0';

export const config = {
  nodeEnv: env.NODE_ENV,
  isProduction,
  port: env.PORT,
  /** Shared bearer token; when undefined, auth is disabled (dev only). */
  serviceToken: env.WEBFETCH_TOOL_TOKEN,
} as const;

export type Config = typeof config;
