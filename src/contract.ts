/**
 * The tool's declared contract (#13, companion to hadron-server#4882): a versioned promise core reads before it
 * sends a secret-bearing request, served at GET /ops/contract. It is separate from GET /info, which reports
 * build facts only (ruling, Bill, #139613).
 *
 * The advertisement cannot drift from the behaviour: `HONOURS_REDIRECTS_NONE` is the ONE constant that both
 * (a) decides whether `redirects: "none"` stops http-request at the first hop (src/ops/index.ts) and
 * (b) decides whether `redirects-none` is listed here. Change the behaviour and the declaration moves with it.
 */

/** The contract version. Bump it only with the capability set. */
export const CONTRACT_VERSION = 'webfetch@2';

/** True while `redirects: "none"` returns a 3xx as-is and sends nothing to a second hop, on http-request. */
export const HONOURS_REDIRECTS_NONE = true;

/** The capabilities declared, derived from the constants that drive the behaviour. */
export function declaredCapabilities(): string[] {
  const caps: string[] = [];
  if (HONOURS_REDIRECTS_NONE) caps.push('redirects-none');
  return caps;
}

/** The exact body of GET /ops/contract. Key order is part of the contract; core reads it strictly. */
export function contractBody(): { contract: string; capabilities: string[] } {
  return { contract: CONTRACT_VERSION, capabilities: declaredCapabilities() };
}
