# Agent dev guide — hadrontool-webfetch

**hadrontool-webfetch** is an independently-deployed, **stateless** web
fetch/request capability tool for the Hadron platform: it gives headless LLM
runs a governed web surface (read pages, call HTTP APIs including POST)
behind an SSRF-guarded, connection-pinned egress policy. Core
(hadron-server) keeps the contract, identity, and ALL authorization; this
tool executes fetches and nothing else.

**Design issue: hadron-server#628** (decisions, phases, and the credential
model). Sibling tools: `hadrontool-pdf` (the stateless template this repo
copies) and `hadrontool-ms-exchange` (the `defineOp` ops-registry pattern).

## Commands

```bash
npm run dev          # tsx watch (port 8080)
npm test             # vitest — real HTTP via supertest over FAKE fetch seams
npm run typecheck
```

No database, no Prisma, no migrations — nothing to set up.

## Structure

- `src/guard.ts` — the cor:api:130:02 egress policy. `isForbiddenAddress` /
  `embeddedIpv4` are VERBATIM ports of hadron-server's `src/lib/webFetch.ts`
  (PR-486-reviewed); keep them in sync with core until core delegates here.
- `src/fetcher.ts` — the guarded engine: per-hop resolve → validate → PIN
  (custom undici dispatcher lookup; closes core's accepted resolve-then-fetch
  TOCTOU), manual redirects with per-hop revalidation, one abort budget
  covering the body read, credential drop on cross-origin redirects,
  streaming byte cap (truncate + flag).
- `src/ops/index.ts` — the operation registry (`fetch-url`, `check-url`,
  `http-request`); one zod schema per op via `defineOp`.
- `src/convert.ts` — sanitize-html → turndown+GFM (the hadrontool-pdf
  pipeline, spec cor:cnv:010:01) + text/links extraction.
- `src/routes/` — `ops` (bearer-gated internal plane), `health` (open).
- Tests inject `FetcherDeps` fakes — no network, no DNS in the suite.

## Key invariants

- **Stateless.** No database, no keys, no connection records. Credentials
  arrive inline per request (`auth`: bearer / basic / header) — the caller
  (core) sources them. Consequence: NO idempotency ledger is possible, so
  core's webfetchClient must never auto-retry non-GET calls.
- **All authorization happens in core.** Anonymous POST is allowed here by
  design; the policy chain (`tool.web_fetch` / `tool.web_request`) governs
  callers. Never add authorization logic to this tool.
- **The egress guard is non-negotiable.** Every hop of every request goes
  through parse → resolve → validate-every-address → pinned connect. Never
  add a fetch path that bypasses `performFetch`.
- **Credentials never leak.** Not into logs (log codes/hosts/statuses only),
  not into error bodies (zod messages don't echo values), not across
  cross-origin redirects, not via plain `headers` (authorization/cookie are
  rejected there — `auth` only).
- **Non-GET never follows redirects.** The 3xx returns to the caller.
- **Fetched content is untrusted** — response envelopes carry
  `source: "external"` so core's framing can wrap it.
- **Agent-agnostic.** No agent names in `src/` (Constitution Invariant #14).

## Use of Hadron

This tool has no memory of its own — work against the shared ones:

- `hrn:memory:hadronmemory.com::dev` — findings, conventions, ops, `preflight`
- `hrn:memory:hadronmemory.com::specs` — product specs (`cor:api:130:02` is
  the egress policy this tool implements and hardens)

Query Hadron before reading code/design (`hadron_find_nodes` → `hadron_get_node`),
and capture non-obvious findings as nodes the moment they emerge.
