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
  // Polling plane (spec cor:web:030) — all three required to enable it;
  // absent, the tool runs ops-only exactly as before.
  DATABASE_URL: z.string().min(1).optional(),
  TOKEN_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex chars').optional(),
  CORE_EVENTS_URL: z.string().min(1).optional(),
  CORE_EVENTS_TOKEN: z.string().min(1).optional(),
  POLL_MIN_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  POLL_MAX_TTL_DAYS: z.coerce.number().int().positive().default(30),
  POLL_MAX_ACTIVE_PER_ORG: z.coerce.number().int().positive().default(25),
  POLL_FAILURE_LIMIT: z.coerce.number().int().positive().default(10),
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

/** The polling plane boots only when its whole env quorum is present. */
const pollingConfigured = Boolean(env.DATABASE_URL && env.TOKEN_ENCRYPTION_KEY && env.CORE_EVENTS_URL);

export const config = {
  nodeEnv: env.NODE_ENV,
  isProduction,
  port: env.PORT,
  /** Shared bearer token; when undefined, auth is disabled (dev only). */
  serviceToken: env.WEBFETCH_TOOL_TOKEN,
  polling: {
    configured: pollingConfigured,
    databaseUrl: env.DATABASE_URL,
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY,
    coreEventsUrl: env.CORE_EVENTS_URL,
    coreEventsToken: env.CORE_EVENTS_TOKEN,
    minIntervalSeconds: env.POLL_MIN_INTERVAL_SECONDS,
    maxTtlDays: env.POLL_MAX_TTL_DAYS,
    maxActivePerOrg: env.POLL_MAX_ACTIVE_PER_ORG,
    failureLimit: env.POLL_FAILURE_LIMIT,
  },
} as const;

export type Config = typeof config;
