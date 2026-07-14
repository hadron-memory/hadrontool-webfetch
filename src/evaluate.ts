/**
 * The condition language + evaluator shared by the stateless `evaluate-url`
 * op and (once it lands) the polling plane's scheduler tick (issue #4). One
 * pure function over already-fetched content: no fetching, no state — the
 * caller supplies the previous tick's snapshot as `baseline`, so `changed`
 * semantics work without the tool remembering anything.
 *
 * Kind rules: `selector_*` conditions require HTML, `json_path` requires
 * JSON, `text_contains`/`content_changed` work on either. Mixing HTML-only
 * and JSON-only conditions in one set is rejected — one fetch yields one
 * document.
 *
 * First-tick rule: a `changed`-type condition with no baseline entry does
 * NOT match — it records its snapshot value instead. Absolute conditions
 * evaluate normally on the first tick (already-true is a legitimate match).
 *
 * `regex` is a ReDoS surface: contained by the pattern-length cap plus the
 * fact that callers are core-governed agents, not anonymous (issue #4).
 */

import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { z } from 'zod';
import { ValidationError } from './errors.js';
import { htmlToText } from './convert.js';

export const MAX_CONDITIONS = 10;
const MAX_ID_CHARS = 64;
const MAX_SELECTOR_CHARS = 200;
const MAX_VALUE_CHARS = 1_000;
const MAX_REGEX_CHARS = 256;
const MAX_PATH_CHARS = 200;
/** Snapshot values are echoed back per tick — keep them token-cheap. */
const MAX_SNAPSHOT_VALUE_CHARS = 500;

const idSchema = z.string().min(1).max(MAX_ID_CHARS);
const selectorSchema = z.string().min(1).max(MAX_SELECTOR_CHARS);

export const conditionSchema = z.discriminatedUnion('type', [
  z.object({ id: idSchema, type: z.literal('selector_exists'), selector: selectorSchema }).strict(),
  z
    .object({
      id: idSchema,
      type: z.literal('selector_text'),
      selector: selectorSchema,
      op: z.enum(['contains', 'equals', 'regex', 'changed']),
      value: z.string().min(1).max(MAX_VALUE_CHARS).optional(),
    })
    .strict(),
  z.object({ id: idSchema, type: z.literal('text_contains'), value: z.string().min(1).max(MAX_VALUE_CHARS) }).strict(),
  z.object({ id: idSchema, type: z.literal('content_changed') }).strict(),
  z
    .object({
      id: idSchema,
      type: z.literal('json_path'),
      path: z.string().min(1).max(MAX_PATH_CHARS),
      op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists', 'changed']),
      value: z.union([z.string().max(MAX_VALUE_CHARS), z.number(), z.boolean(), z.null()]).optional(),
    })
    .strict(),
]);

export type Condition = z.infer<typeof conditionSchema>;

export const conditionsSchema = z.array(conditionSchema).min(1).max(MAX_CONDITIONS);
export const modeSchema = z.enum(['any', 'all']).default('any');

export const baselineSchema = z
  .object({
    hash: z.string().max(128).optional(),
    values: z.record(z.string(), z.string().max(MAX_SNAPSHOT_VALUE_CHARS)).optional(),
  })
  .strict();

export type Baseline = z.infer<typeof baselineSchema>;

export type ContentKind = 'html' | 'json';

const HTML_ONLY_TYPES = new Set(['selector_exists', 'selector_text']);
const JSON_ONLY_TYPES = new Set(['json_path']);
const NUMERIC_OPS = new Set(['gt', 'gte', 'lt', 'lte']);

/**
 * Cross-field checks zod's discriminated union can't express. Throws
 * ValidationError (the field names the offending condition id).
 */
export function validateConditions(conditions: Condition[]): void {
  const seen = new Set<string>();
  let hasHtmlOnly = false;
  let hasJsonOnly = false;
  for (const c of conditions) {
    if (seen.has(c.id)) {
      throw new ValidationError(`conditions.${c.id}`, `duplicate condition id "${c.id}"`);
    }
    seen.add(c.id);
    hasHtmlOnly ||= HTML_ONLY_TYPES.has(c.type);
    hasJsonOnly ||= JSON_ONLY_TYPES.has(c.type);
    if (c.type === 'selector_text') {
      if (c.op !== 'changed' && c.value === undefined) {
        throw new ValidationError(`conditions.${c.id}`, `op "${c.op}" requires a value`);
      }
      if (c.op === 'regex') compileRegex(c.id, c.value as string);
    }
    if (c.type === 'json_path') {
      parsePath(c.id, c.path);
      if (c.op !== 'exists' && c.op !== 'changed' && c.value === undefined) {
        throw new ValidationError(`conditions.${c.id}`, `op "${c.op}" requires a value`);
      }
      if (NUMERIC_OPS.has(c.op) && typeof c.value !== 'number') {
        throw new ValidationError(`conditions.${c.id}`, `op "${c.op}" requires a numeric value`);
      }
    }
  }
  if (hasHtmlOnly && hasJsonOnly) {
    throw new ValidationError('conditions', 'selector_* and json_path conditions cannot be mixed — one fetch yields one document');
  }
}

/** The content kind a condition set can evaluate against, if it forces one. */
export function requiredKind(conditions: Condition[]): ContentKind | undefined {
  if (conditions.some((c) => HTML_ONLY_TYPES.has(c.type))) return 'html';
  if (conditions.some((c) => JSON_ONLY_TYPES.has(c.type))) return 'json';
  return undefined;
}

function compileRegex(id: string, pattern: string): RegExp {
  if (pattern.length > MAX_REGEX_CHARS) {
    throw new ValidationError(`conditions.${id}`, `regex pattern exceeds ${MAX_REGEX_CHARS} characters`);
  }
  try {
    return new RegExp(pattern);
  } catch {
    throw new ValidationError(`conditions.${id}`, 'invalid regex pattern');
  }
}

/** Dot/bracket path → segments: a.b, a[0], a["k"], a['k']. No full JSONPath. */
function parsePath(id: string, path: string): (string | number)[] {
  const segments: (string | number)[] = [];
  const re = /\.?([A-Za-z_$][\w$]*)|\[(\d+)\]|\[(?:"([^"]*)"|'([^']*)')\]/y;
  let pos = 0;
  while (pos < path.length) {
    re.lastIndex = pos;
    const m = re.exec(path);
    if (!m || m.index !== pos) {
      throw new ValidationError(`conditions.${id}`, `invalid path "${path}"`);
    }
    if (m[1] !== undefined) segments.push(m[1]);
    else if (m[2] !== undefined) segments.push(Number(m[2]));
    else segments.push(m[3] ?? m[4] ?? '');
    pos = re.lastIndex;
  }
  if (segments.length === 0) {
    throw new ValidationError(`conditions.${id}`, `invalid path "${path}"`);
  }
  return segments;
}

function resolvePath(root: unknown, segments: (string | number)[]): unknown {
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

/** Stable string form used for `changed` baselines and `actual` echoes. */
function snapshotValue(v: unknown): string {
  const s = typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v);
  return s.slice(0, MAX_SNAPSHOT_VALUE_CHARS);
}

function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface ConditionResult {
  id: string;
  matched: boolean;
  /** The observed value, for changed/text conditions — capped, never a credential source (response content only). */
  actual?: string | null;
}

export interface EvaluationOutcome {
  triggered: boolean;
  results: ConditionResult[];
  snapshot: { hash: string; values: Record<string, string> };
}

export interface EvaluateInput {
  conditions: Condition[];
  mode: 'any' | 'all';
  kind: ContentKind;
  bodyText: string;
  baseline?: Baseline;
}

/**
 * Evaluate a validated condition set against fetched content. Pure: the only
 * inputs are the arguments; `changed` semantics come from `baseline`.
 * Throws ValidationError when `kind` is json and the body is not valid JSON
 * (for a poll tick this is a fetch-shaped failure, counted toward backoff).
 */
export function evaluateConditions(input: EvaluateInput): EvaluationOutcome {
  const { conditions, mode, kind, bodyText, baseline } = input;
  const forced = requiredKind(conditions);
  if (forced !== undefined && forced !== kind) {
    throw new ValidationError('conditions', `these conditions require ${forced} content, got ${kind}`);
  }

  let $: cheerio.CheerioAPI | undefined;
  let pageText = '';
  let json: unknown;
  if (kind === 'html') {
    // Selectors run on the RAW document: sanitizePage strips id/class (so
    // `#price` would never match), and cheerio only parses — nothing
    // executes. Sanitization guards LLM-bound output, not DOM queries; the
    // `actual` echoes are plain text and the envelope is source:"external".
    $ = cheerio.load(bodyText);
    pageText = htmlToText(bodyText);
  } else {
    try {
      json = JSON.parse(bodyText);
    } catch {
      throw new ValidationError('content', 'the response body is not valid JSON');
    }
    pageText = bodyText;
  }
  const hash = createHash('sha256').update(pageText).digest('hex');

  const values: Record<string, string> = {};
  const results: ConditionResult[] = [];

  for (const c of conditions) {
    let matched = false;
    let actual: string | null | undefined;
    switch (c.type) {
      case 'selector_exists':
        matched = select($!, c.id, c.selector).length > 0;
        break;
      case 'selector_text': {
        const el = select($!, c.id, c.selector).first();
        actual = el.length > 0 ? snapshotValue(el.text().replace(/\s+/g, ' ').trim()) : null;
        if (c.op === 'changed') {
          if (actual != null) values[c.id] = actual;
          matched = changedAgainstBaseline(baseline, c.id, actual);
        } else if (actual != null) {
          if (c.op === 'contains') matched = actual.includes(c.value as string);
          else if (c.op === 'equals') matched = actual === c.value;
          else matched = compileRegex(c.id, c.value as string).test(actual);
        }
        break;
      }
      case 'text_contains':
        matched = pageText.includes(c.value);
        break;
      case 'content_changed':
        matched = baseline?.hash !== undefined && baseline.hash !== hash;
        break;
      case 'json_path': {
        const v = resolvePath(json, parsePath(c.id, c.path));
        actual = v === undefined ? null : snapshotValue(v);
        if (c.op === 'exists') matched = v !== undefined;
        else if (c.op === 'changed') {
          if (actual != null) values[c.id] = actual;
          matched = changedAgainstBaseline(baseline, c.id, actual);
        } else if (v !== undefined) {
          if (c.op === 'eq') matched = jsonEquals(v, c.value);
          else if (c.op === 'ne') matched = !jsonEquals(v, c.value);
          else if (c.op === 'contains') {
            matched = Array.isArray(v)
              ? v.some((item) => jsonEquals(item, c.value))
              : typeof v === 'string' && typeof c.value === 'string' && v.includes(c.value);
          } else {
            const n = typeof v === 'number' ? v : Number.NaN;
            const bound = c.value as number;
            if (Number.isFinite(n)) {
              if (c.op === 'gt') matched = n > bound;
              else if (c.op === 'gte') matched = n >= bound;
              else if (c.op === 'lt') matched = n < bound;
              else matched = n <= bound;
            }
          }
        }
        break;
      }
    }
    results.push({ id: c.id, matched, ...(actual !== undefined ? { actual } : {}) });
  }

  const triggered = mode === 'all' ? results.every((r) => r.matched) : results.some((r) => r.matched);
  return { triggered, results, snapshot: { hash, values } };
}

/** First-tick rule: no baseline entry → record, don't match. */
function changedAgainstBaseline(baseline: Baseline | undefined, id: string, actual: string | null): boolean {
  const prev = baseline?.values?.[id];
  return prev !== undefined && actual !== null && prev !== actual;
}

function select($: cheerio.CheerioAPI, id: string, selector: string): ReturnType<cheerio.CheerioAPI> {
  try {
    return $(selector);
  } catch {
    throw new ValidationError(`conditions.${id}`, 'invalid CSS selector');
  }
}
