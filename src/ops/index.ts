/**
 * The operation registry — the hadron-server#628 contract surface.
 *
 * `POST /ops/<operation>`; each operation has ONE zod schema (defineOp parses
 * before the handler runs — no shadow schema to drift from the declared
 * contract; the defineOp pattern is hadrontool-ms-exchange's). The tool is
 * stateless: no idempotency ledger is possible, so core's webfetchClient must
 * never auto-retry non-GET calls.
 *
 * v1 operations: fetch-url (GET a page, normalized), check-url (HEAD probe),
 * http-request (API calls, any method — anonymous POST allowed by design;
 * ALL authorization happens in core before a request reaches this tool),
 * evaluate-url (GET + condition evaluation — the polling tick primitive,
 * exposed statelessly; issue #4).
 *
 * Every response envelope carries `source: "external"` where content from
 * the fetched resource is included — fetched content is untrusted input to
 * the LLM and core's framing wraps it accordingly.
 *
 * Spec: cor:web:000 (stateless; core owns authorization; no auto-retry of
 * non-GET; fetched content is untrusted).
 */

import { z } from 'zod';
import { UnsupportedContentTypeError, ValidationError } from '../errors.js';
import {
  DEFAULT_MAX_BYTES,
  HARD_MAX_BYTES,
  performFetch,
  type AuthSpec,
  type FetcherDeps,
} from '../fetcher.js';
import { extractLinks, extractTitle, htmlToMarkdown, htmlToText, sanitizePage } from '../convert.js';
import {
  baselineSchema,
  conditionsSchema,
  evaluateConditions,
  modeSchema,
  requiredKind,
  validateConditions,
  type ContentKind,
} from '../evaluate.js';

const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const MAX_HEADER_VALUE_CHARS = 4_096;
const MAX_EXTRA_HEADERS = 20;

/**
 * Characters an HTTP header value (or credential built into one) may not
 * carry: the whole C0 control range and DEL, minus HTAB (0x09), which
 * RFC 7230 field-content permits. CR/LF/NUL are the classic injection shapes,
 * but any control char (e.g. 0x01, 0x7f) is equally rejected by undici at the
 * socket — owning the check here means all of them fail as validation_error
 * rather than an opaque fetch_failed.
 */
// eslint-disable-next-line no-control-regex
const HEADER_VALUE_INVALID_RE = /[\x00-\x08\x0a-\x1f\x7f]/;
const noControlChars = (v: string) => !HEADER_VALUE_INVALID_RE.test(v);

/**
 * Headers a caller may never set directly: connection-structural ones (the
 * fetch layer owns them) plus credential carriers, which MUST come through
 * `auth` so the cross-origin redirect drop protects them.
 *
 * Spec: cor:web:010:02 (credentials only via the dedicated auth channel).
 */
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'expect',
  'te',
  'trailer',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
]);
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie']);

/** fetch-url only allows content-negotiation headers. */
const FETCH_URL_HEADER_ALLOWLIST = new Set(['accept', 'accept-language']);

const authSchema: z.ZodType<AuthSpec> = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('bearer'),
      token: z.string().min(1).max(MAX_HEADER_VALUE_CHARS).refine(noControlChars, 'invalid token'),
    })
    .strict(),
  z
    .object({
      type: z.literal('basic'),
      username: z.string().min(1).max(MAX_HEADER_VALUE_CHARS).refine(noControlChars, 'invalid username'),
      password: z.string().min(1).max(MAX_HEADER_VALUE_CHARS).refine(noControlChars, 'invalid password'),
    })
    .strict(),
  z
    .object({
      type: z.literal('header'),
      name: z
        .string()
        .regex(HEADER_NAME_RE, 'invalid header name')
        .refine((n) => !FORBIDDEN_REQUEST_HEADERS.has(n.toLowerCase()), 'this header cannot carry a credential'),
      value: z.string().min(1).max(MAX_HEADER_VALUE_CHARS).refine(noControlChars, 'invalid header value'),
    })
    .strict(),
]);

/** Lowercase keys + reject structural/credential headers. */
function normalizeHeaders(
  headers: Record<string, string> | undefined,
  allowlist?: Set<string>,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const entries = Object.entries(headers);
  if (entries.length > MAX_EXTRA_HEADERS) {
    throw new ValidationError('headers', `at most ${MAX_EXTRA_HEADERS} extra headers are allowed`);
  }
  const out: Record<string, string> = {};
  for (const [rawName, value] of entries) {
    const name = rawName.toLowerCase();
    if (!HEADER_NAME_RE.test(rawName)) {
      throw new ValidationError('headers', `invalid header name "${rawName}"`);
    }
    if (FORBIDDEN_REQUEST_HEADERS.has(name)) {
      throw new ValidationError('headers', `the "${name}" header cannot be set by callers`);
    }
    if (CREDENTIAL_HEADERS.has(name)) {
      throw new ValidationError('headers', `credentials must be passed via the "auth" field, not the "${name}" header`);
    }
    if (allowlist && !allowlist.has(name)) {
      throw new ValidationError('headers', `only ${[...allowlist].join(', ')} headers are allowed on this operation`);
    }
    if (value.length > MAX_HEADER_VALUE_CHARS) {
      throw new ValidationError('headers', `header "${name}" value exceeds ${MAX_HEADER_VALUE_CHARS} characters`);
    }
    if (!noControlChars(value)) {
      throw new ValidationError('headers', `header "${name}" value contains invalid characters`);
    }
    out[name] = value;
  }
  return out;
}

const urlSchema = z.string().min(1).max(2_000);
const maxBytesSchema = z.number().int().positive().max(HARD_MAX_BYTES).optional();
const headersSchema = z.record(z.string(), z.string()).optional();

/** One operation: the single input schema + the handler over parsed input. */
export interface OperationDef {
  schema: z.ZodType;
  run(deps: FetcherDeps, input: Record<string, unknown>): Promise<unknown>;
}

/**
 * Define an operation with ONE schema: defineOp parses the raw input against
 * it and hands the handler the typed result.
 */
function defineOp<S extends z.ZodType>(
  schema: S,
  handler: (deps: FetcherDeps, input: z.infer<S>) => Promise<unknown>,
): OperationDef {
  return {
    schema,
    run: (deps, raw) => handler(deps, schema.parse(raw)),
  };
}

const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);

const fetchUrlSchema = z
  .object({
    url: urlSchema,
    format: z.enum(['markdown', 'text', 'html', 'links']).default('markdown'),
    maxBytes: maxBytesSchema,
    headers: headersSchema,
    auth: authSchema.optional(),
  })
  .strict();

const fetchUrl = defineOp(fetchUrlSchema, async (deps, input) => {
  const outcome = await performFetch(
    {
      method: 'GET',
      url: input.url,
      headers: normalizeHeaders(input.headers, FETCH_URL_HEADER_ALLOWLIST),
      auth: input.auth,
      maxBytes: input.maxBytes ?? DEFAULT_MAX_BYTES,
      followRedirects: true,
    },
    deps,
  );
  const isHtml = outcome.contentType != null && HTML_TYPES.has(outcome.contentType);
  const raw = outcome.bodyText ?? '';
  const base = {
    finalUrl: outcome.finalUrl,
    status: outcome.status,
    contentType: outcome.contentType,
    truncated: outcome.truncated,
    source: 'external' as const,
    ...(isHtml ? { title: extractTitle(raw) ?? null } : {}),
  };
  switch (input.format) {
    case 'markdown':
      return { ...base, content: isHtml ? htmlToMarkdown(raw) : raw };
    case 'text':
      return { ...base, content: isHtml ? htmlToText(raw) : raw };
    case 'html':
      return { ...base, content: isHtml ? sanitizePage(raw) : raw };
    case 'links':
      return { ...base, links: isHtml ? extractLinks(raw, outcome.finalUrl) : [] };
  }
});

const checkUrlSchema = z
  .object({
    url: urlSchema,
    auth: authSchema.optional(),
  })
  .strict();

const checkUrl = defineOp(checkUrlSchema, async (deps, input) => {
  const outcome = await performFetch(
    { method: 'HEAD', url: input.url, auth: input.auth, followRedirects: false },
    deps,
  );
  const contentLength = outcome.headers['content-length'];
  const parsedLength = contentLength != null ? parseInt(contentLength, 10) : NaN;
  return {
    finalUrl: outcome.finalUrl,
    status: outcome.status,
    contentType: outcome.contentType,
    contentLength: Number.isFinite(parsedLength) ? parsedLength : null,
    redirectLocation: outcome.status >= 300 && outcome.status < 400 ? (outcome.headers['location'] ?? null) : null,
  };
});

const httpRequestSchema = z
  .object({
    method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']),
    url: urlSchema,
    headers: headersSchema,
    body: z.string().max(HARD_MAX_BYTES).optional(),
    json: z.unknown().optional(),
    auth: authSchema.optional(),
    maxBytes: maxBytesSchema,
  })
  .strict();

const httpRequest = defineOp(httpRequestSchema, async (deps, input) => {
  const hasJson = input.json !== undefined;
  const hasBody = input.body !== undefined;
  if (hasJson && hasBody) {
    throw new ValidationError('body', 'pass either "body" or "json", not both');
  }
  if ((hasJson || hasBody) && (input.method === 'GET' || input.method === 'HEAD')) {
    throw new ValidationError('body', `a ${input.method} request cannot carry a body`);
  }
  const body = hasJson ? JSON.stringify(input.json) : input.body;
  const outcome = await performFetch(
    {
      method: input.method,
      url: input.url,
      headers: normalizeHeaders(input.headers),
      body,
      contentType: hasJson ? 'application/json' : undefined,
      auth: input.auth,
      maxBytes: input.maxBytes ?? DEFAULT_MAX_BYTES,
      // Auto-replaying a body across a redirect hop is both a 307/303
      // correctness trap and a leak vector — only safe methods follow.
      // Spec: cor:web:010:02 (non-GET never follows redirects).
      followRedirects: input.method === 'GET' || input.method === 'HEAD',
    },
    deps,
  );
  const isJson =
    outcome.contentType != null && (outcome.contentType === 'application/json' || outcome.contentType.endsWith('+json'));
  let responseBody: unknown = outcome.bodyText;
  if (isJson && !outcome.truncated && outcome.bodyText != null) {
    try {
      responseBody = JSON.parse(outcome.bodyText);
    } catch {
      // Malformed JSON from the remote — hand back the raw text.
    }
  }
  return {
    finalUrl: outcome.finalUrl,
    status: outcome.status,
    contentType: outcome.contentType,
    headers: outcome.headers,
    body: responseBody,
    truncated: outcome.truncated,
    source: 'external' as const,
  };
});

const JSON_TYPES = (ct: string) => ct === 'application/json' || ct.endsWith('+json');

const evaluateUrlSchema = z
  .object({
    url: urlSchema,
    contentKind: z.enum(['auto', 'html', 'json']).default('auto'),
    conditions: conditionsSchema,
    mode: modeSchema,
    baseline: baselineSchema.optional(),
    headers: headersSchema,
    auth: authSchema.optional(),
    maxBytes: maxBytesSchema,
  })
  .strict();

/**
 * The polling tick primitive, exposed statelessly (issue #4): GET the URL
 * through the full guard, evaluate the condition set, and return the
 * snapshot the caller feeds back as `baseline` next time. The (future)
 * polling plane's scheduler calls the same evaluateConditions internally.
 * Spec: cor:web:030:01 (lifecycle/condition semantics; the plane itself is
 * cor:web:030:00..03).
 */
const evaluateUrl = defineOp(evaluateUrlSchema, async (deps, input) => {
  validateConditions(input.conditions);
  const outcome = await performFetch(
    {
      method: 'GET',
      url: input.url,
      headers: normalizeHeaders(input.headers, FETCH_URL_HEADER_ALLOWLIST),
      auth: input.auth,
      maxBytes: input.maxBytes ?? DEFAULT_MAX_BYTES,
      followRedirects: true,
    },
    deps,
  );
  const ct = outcome.contentType ?? '';
  let kind: ContentKind;
  if (input.contentKind !== 'auto') {
    // Explicit kind wins; a conflict with the conditions is the caller's
    // input error (evaluateConditions raises validation_error).
    kind = input.contentKind;
  } else {
    // Auto: kind-agnostic conditions treat any non-JSON textual body as a
    // page; a kind the conditions force but the content can't satisfy is a
    // content mismatch (415), not an input error — a poll tick counts it
    // toward backoff like any other fetch-shaped failure.
    kind = JSON_TYPES(ct) ? 'json' : 'html';
    const forced = requiredKind(input.conditions);
    if (forced !== undefined && forced !== kind) {
      throw new UnsupportedContentTypeError(ct || 'unknown');
    }
  }
  const evaluation = evaluateConditions({
    conditions: input.conditions,
    mode: input.mode,
    kind,
    bodyText: outcome.bodyText ?? '',
    baseline: input.baseline,
  });
  return {
    triggered: evaluation.triggered,
    results: evaluation.results,
    snapshot: evaluation.snapshot,
    finalUrl: outcome.finalUrl,
    status: outcome.status,
    contentType: outcome.contentType,
    truncated: outcome.truncated,
    source: 'external' as const,
  };
});

export const OPERATIONS: Record<string, OperationDef> = {
  'fetch-url': fetchUrl,
  'check-url': checkUrl,
  'http-request': httpRequest,
  'evaluate-url': evaluateUrl,
};

export async function runOperation(deps: FetcherDeps, name: string, input: Record<string, unknown>): Promise<unknown> {
  const def = OPERATIONS[name];
  if (!def) throw new ValidationError('operation', `unknown operation "${name}"`);
  return def.run(deps, input);
}
