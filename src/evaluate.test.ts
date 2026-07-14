/**
 * Pure evaluator tests: condition semantics, the first-tick baseline rule,
 * kind enforcement, and the validation catalog — no fetching involved.
 */

import { describe, expect, it } from 'vitest';
import { ValidationError } from './errors.js';
import { evaluateConditions, validateConditions, requiredKind, type Condition } from './evaluate.js';

const PAGE = `<html><body>
  <h1 class="title">Widget</h1>
  <span id="price">$ 129.00</span>
  <div class="stock">Out of stock</div>
</body></html>`;

function evalHtml(conditions: Condition[], opts: { mode?: 'any' | 'all'; baseline?: { hash?: string; values?: Record<string, string> } } = {}) {
  return evaluateConditions({ conditions, mode: opts.mode ?? 'any', kind: 'html', bodyText: PAGE, baseline: opts.baseline });
}

function evalJson(body: unknown, conditions: Condition[], baseline?: { hash?: string; values?: Record<string, string> }) {
  return evaluateConditions({ conditions, mode: 'any', kind: 'json', bodyText: JSON.stringify(body), baseline });
}

describe('HTML conditions', () => {
  it('selector_exists matches present and absent selectors', () => {
    const out = evalHtml([
      { id: 'has', type: 'selector_exists', selector: '#price' },
      { id: 'not', type: 'selector_exists', selector: '.sale-banner' },
    ]);
    expect(out.results).toEqual([
      { id: 'has', matched: true },
      { id: 'not', matched: false },
    ]);
    expect(out.triggered).toBe(true);
  });

  it('selector_text contains/equals/regex evaluate the first match, whitespace-normalized', () => {
    const out = evalHtml([
      { id: 'c', type: 'selector_text', selector: '.stock', op: 'contains', value: 'Out of' },
      { id: 'e', type: 'selector_text', selector: 'h1.title', op: 'equals', value: 'Widget' },
      { id: 'r', type: 'selector_text', selector: '#price', op: 'regex', value: '\\$ \\d+\\.\\d{2}' },
      { id: 'gone', type: 'selector_text', selector: '.missing', op: 'contains', value: 'x' },
    ]);
    expect(out.results[0]).toEqual({ id: 'c', matched: true, actual: 'Out of stock' });
    expect(out.results[1].matched).toBe(true);
    expect(out.results[2].matched).toBe(true);
    // A missing element never matches and reports actual: null.
    expect(out.results[3]).toEqual({ id: 'gone', matched: false, actual: null });
  });

  it('text_contains sees the extracted page text', () => {
    const out = evalHtml([{ id: 't', type: 'text_contains', value: 'Out of stock' }]);
    expect(out.triggered).toBe(true);
  });

  it('content_changed: first tick records, second tick fires on a different hash', () => {
    const first = evalHtml([{ id: 'w', type: 'content_changed' }]);
    expect(first.triggered).toBe(false);
    expect(first.snapshot.hash).toMatch(/^[0-9a-f]{64}$/);

    const same = evalHtml([{ id: 'w', type: 'content_changed' }], { baseline: { hash: first.snapshot.hash } });
    expect(same.triggered).toBe(false);

    const changed = evalHtml([{ id: 'w', type: 'content_changed' }], { baseline: { hash: 'deadbeef' } });
    expect(changed.triggered).toBe(true);
  });

  it('selector_text changed: first tick records the value without matching', () => {
    const cond: Condition[] = [{ id: 'p', type: 'selector_text', selector: '#price', op: 'changed' }];
    const first = evalHtml(cond);
    expect(first.results[0].matched).toBe(false);
    expect(first.snapshot.values).toEqual({ p: '$ 129.00' });

    const same = evalHtml(cond, { baseline: { values: { p: '$ 129.00' } } });
    expect(same.triggered).toBe(false);

    const moved = evalHtml(cond, { baseline: { values: { p: '$ 149.00' } } });
    expect(moved.triggered).toBe(true);
  });
});

describe('JSON conditions', () => {
  const DOC = { status: 'open', count: 3, items: [{ sku: 'a-1', price: 99.5 }], tags: ['new', 'sale'] };

  it('comparators over paths, including bracket segments', () => {
    const out = evalJson(DOC, [
      { id: 'eq', type: 'json_path', path: 'status', op: 'eq', value: 'open' },
      { id: 'gt', type: 'json_path', path: 'items[0].price', op: 'gt', value: 50 },
      { id: 'lt', type: 'json_path', path: 'count', op: 'lt', value: 3 },
      { id: 'in', type: 'json_path', path: 'tags', op: 'contains', value: 'sale' },
      { id: 'has', type: 'json_path', path: 'items[0]["sku"]', op: 'exists' },
      { id: 'no', type: 'json_path', path: 'missing.deep', op: 'exists' },
    ]);
    expect(out.results.map((r) => [r.id, r.matched])).toEqual([
      ['eq', true],
      ['gt', true],
      ['lt', false],
      ['in', true],
      ['has', true],
      ['no', false],
    ]);
  });

  it('a missing path never matches value comparators (only exists/changed see absence)', () => {
    const out = evalJson(DOC, [{ id: 'ne', type: 'json_path', path: 'missing', op: 'ne', value: 'x' }]);
    expect(out.results[0]).toEqual({ id: 'ne', matched: false, actual: null });
  });

  it('changed uses the recorded per-condition value', () => {
    const cond: Condition[] = [{ id: 'n', type: 'json_path', path: 'count', op: 'changed' }];
    const first = evalJson(DOC, cond);
    expect(first.triggered).toBe(false);
    expect(first.snapshot.values).toEqual({ n: '3' });
    const bumped = evalJson({ ...DOC, count: 4 }, cond, { values: first.snapshot.values });
    expect(bumped.triggered).toBe(true);
  });

  it('rejects a body that is not valid JSON', () => {
    expect(() =>
      evaluateConditions({
        conditions: [{ id: 'x', type: 'json_path', path: 'a', op: 'exists' }],
        mode: 'any',
        kind: 'json',
        bodyText: '<html>not json</html>',
      }),
    ).toThrow(ValidationError);
  });
});

describe('mode + kind enforcement', () => {
  it('all requires every condition; any requires one', () => {
    const conds: Condition[] = [
      { id: 'yes', type: 'text_contains', value: 'Widget' },
      { id: 'no', type: 'text_contains', value: 'absent-string' },
    ];
    expect(evalHtml(conds, { mode: 'any' }).triggered).toBe(true);
    expect(evalHtml(conds, { mode: 'all' }).triggered).toBe(false);
  });

  it('kind-forcing conditions refuse the wrong kind', () => {
    expect(() =>
      evaluateConditions({
        conditions: [{ id: 's', type: 'selector_exists', selector: 'h1' }],
        mode: 'any',
        kind: 'json',
        bodyText: '{}',
      }),
    ).toThrow(ValidationError);
  });

  it('requiredKind reports the forced kind', () => {
    expect(requiredKind([{ id: 'a', type: 'selector_exists', selector: 'h1' }])).toBe('html');
    expect(requiredKind([{ id: 'a', type: 'json_path', path: 'x', op: 'exists' }])).toBe('json');
    expect(requiredKind([{ id: 'a', type: 'content_changed' }])).toBeUndefined();
  });
});

describe('validateConditions', () => {
  const bad = (conditions: Condition[], reason: RegExp) => {
    expect(() => validateConditions(conditions)).toThrowError(reason);
  };

  it('rejects duplicate ids', () => {
    bad(
      [
        { id: 'a', type: 'content_changed' },
        { id: 'a', type: 'text_contains', value: 'x' },
      ],
      /duplicate/,
    );
  });

  it('rejects mixing selector_* and json_path', () => {
    bad(
      [
        { id: 'h', type: 'selector_exists', selector: 'h1' },
        { id: 'j', type: 'json_path', path: 'x', op: 'exists' },
      ],
      /cannot be mixed/,
    );
  });

  it('rejects a value-less comparator, a non-numeric bound, a bad regex, a bad path', () => {
    bad([{ id: 'a', type: 'selector_text', selector: 'h1', op: 'contains' }], /requires a value/);
    bad([{ id: 'a', type: 'json_path', path: 'x', op: 'gt', value: 'high' }], /numeric/);
    bad([{ id: 'a', type: 'selector_text', selector: 'h1', op: 'regex', value: '(' }], /invalid regex/);
    bad([{ id: 'a', type: 'json_path', path: 'a..b', op: 'exists' }], /invalid path/);
  });

  it('accepts a full valid set', () => {
    expect(() =>
      validateConditions([
        { id: 'a', type: 'selector_text', selector: '#p', op: 'changed' },
        { id: 'b', type: 'content_changed' },
        { id: 'c', type: 'text_contains', value: 'x' },
      ]),
    ).not.toThrow();
  });
});
