/**
 * Typed error catalog — stable public surface (hadron-server#628).
 *
 * Codes are the PUBLIC contract: hadron-server's webfetchClient passes them
 * through to GraphQL `extensions.code` / run-tool errors verbatim, so their
 * meanings must stay stable. New codes may be added; existing ones never
 * change meaning.
 *
 * Error messages may name hosts and operations but must NEVER echo request
 * input wholesale — operation inputs carry caller-supplied credentials.
 */

/** Base class: every tool error carries a stable `code` + HTTP status. */
export abstract class WebfetchToolError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  /** JSON body shape every error response uses. */
  toBody(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...this.extraFields() };
  }

  protected extraFields(): Record<string, unknown> {
    return {};
  }
}

/** Input failed schema or semantic validation. */
export class ValidationError extends WebfetchToolError {
  readonly code = 'validation_error';
  readonly httpStatus = 400;
  constructor(
    public field: string,
    public reason: string,
  ) {
    super(`This request couldn't be processed: ${reason}`);
  }
  protected extraFields() {
    return { field: this.field, reason: this.reason };
  }
}

/** The egress policy refuses this host (private/reserved/metadata address). */
export class UrlForbiddenError extends WebfetchToolError {
  readonly code = 'url_forbidden';
  readonly httpStatus = 403;
  constructor(public host: string) {
    super(`Fetching from "${host}" is not allowed by the egress policy.`);
  }
  protected extraFields() {
    return { host: this.host };
  }
}

/** DNS resolution failed for the caller-supplied hostname. */
export class UrlUnresolvableError extends WebfetchToolError {
  readonly code = 'url_unresolvable';
  readonly httpStatus = 400;
  constructor(public host: string) {
    super(`Could not resolve host "${host}".`);
  }
  protected extraFields() {
    return { host: this.host };
  }
}

/** The total time budget elapsed (connect, headers, or body read). */
export class FetchTimeoutError extends WebfetchToolError {
  readonly code = 'fetch_timeout';
  readonly httpStatus = 504;
  constructor(public timeoutSeconds: number) {
    super(`The fetch timed out after ${timeoutSeconds}s.`);
  }
  protected extraFields() {
    return { timeoutSeconds: this.timeoutSeconds };
  }
}

/** Network-level failure (refused, reset, TLS, malformed response). */
export class FetchFailedError extends WebfetchToolError {
  readonly code = 'fetch_failed';
  readonly httpStatus = 502;
  constructor(detail?: string) {
    super(detail ? `The fetch failed: ${detail}` : 'The fetch failed.');
  }
}

/** The redirect chain exceeded the hop cap. */
export class TooManyRedirectsError extends WebfetchToolError {
  readonly code = 'too_many_redirects';
  readonly httpStatus = 502;
  constructor(public maxRedirects: number) {
    super(`Too many redirects (max ${maxRedirects}).`);
  }
  protected extraFields() {
    return { maxRedirects: this.maxRedirects };
  }
}

/** The response body is not a textual type this tool can return. */
export class UnsupportedContentTypeError extends WebfetchToolError {
  readonly code = 'unsupported_content_type';
  readonly httpStatus = 415;
  constructor(public contentType: string) {
    super(`Unsupported content-type "${contentType}" — only textual responses are supported.`);
  }
  protected extraFields() {
    return { contentType: this.contentType };
  }
}

/**
 * Build a ValidationError from a zod failure — the ONE place the
 * first-issue/path-join convention lives; `field`/`reason` are part of the
 * stable public error contract, so every plane must flatten identically.
 * Zod issue messages describe expected shapes and never echo received
 * values, so no credential can leak through this path.
 */
export function validationFromZod(err: { issues: { path: PropertyKey[]; message: string }[] }): ValidationError {
  const issue = err.issues[0];
  return new ValidationError(issue?.path.map(String).join('.') || 'input', issue?.message ?? 'invalid input');
}
