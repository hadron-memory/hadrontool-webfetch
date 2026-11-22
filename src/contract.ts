/**
 * The tool's declared contract (#13, companion to hadron-server#4882): a versioned promise core reads before it
 * sends a secret-bearing request, served at GET /ops/contract. It is separate from GET /info, which reports
 * build facts only (ruling, Bill, #139613).
 *
 * The advertisement cannot drift from the behaviour: `SUPPORT.redirectsNone` is the ONE switch that both
 * (a) decides whether http-request accepts `redirects: "none"` (src/ops/index.ts: when it is off, `none` is REFUSED, never
 * quietly turned into following) and (b) decides whether `redirects-none` is listed here. Change it and both move together.
 */

/** The contract version. Bump it only with the capability set. */
export const CONTRACT_VERSION = 'webfetch@2';

/**
 * What this build supports. `redirectsNone` is true while `redirects: "none"` returns a 3xx as-is and sends nothing to a
 * second hop, on http-request. It is an object, not a bare constant, so a test can flip it and prove both sides move.
 * Production code never writes to it.
 */
export const SUPPORT = { redirectsNone: true };

/** The capabilities declared, derived from the switch that drives the behaviour. */
export function declaredCapabilities(): string[] {
  const caps: string[] = [];
  if (SUPPORT.redirectsNone) caps.push('redirects-none');
  return caps;
}

/**
 * The exact bytes of GET /ops/contract, serialised once here so the key order (part of the contract; core reads it
 * strictly) never depends on a framework's JSON settings.
 */
export function contractJson(): string {
  return JSON.stringify({ contract: CONTRACT_VERSION, capabilities: declaredCapabilities() });
}
