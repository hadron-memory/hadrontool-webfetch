# hadrontool-webfetch

Stateless web fetch/request capability tool for the
[Hadron Memory](https://hadronmemory.com/) platform. It gives headless LLM
runs a governed web surface — read pages, probe links, call HTTP APIs
(including POST) — behind an SSRF-guarded, connection-pinned egress policy.

Design and decisions: hadron-server#628. This is the *stateless* capability-tool
flavor (like [`hadrontool-pdf`](https://github.com/hadron-memory/hadrontool-pdf)):
no database, no keys, no connection records. When a fetch needs credentials,
the caller supplies them inline; **all authorization happens in hadron-server**
before a request reaches this service.

## Operations

`POST /ops/<operation>` (bearer-gated, JSON in/out). Errors use a stable typed
catalog (`validation_error`, `url_forbidden`, `url_unresolvable`,
`fetch_timeout`, `fetch_failed`, `too_many_redirects`,
`unsupported_content_type`).

### `fetch-url` — read a page (GET only)

```json
{
  "url": "https://example.com/docs",
  "format": "markdown",
  "maxBytes": 2000000,
  "headers": { "accept-language": "en" },
  "auth": { "type": "bearer", "token": "…" }
}
```

`format`: `markdown` (default; sanitized HTML → GFM markdown), `text`,
`html` (sanitized), or `links` (the absolutized `{text, href}` link graph,
capped at 500). Response: `{ok, finalUrl, status, contentType, title, content
| links, truncated, source: "external"}`. Redirects are followed (max 3),
re-validated and re-pinned per hop.

### `check-url` — HEAD probe

```json
{ "url": "https://example.com/file.pdf" }
```

Response: `{ok, finalUrl, status, contentType, contentLength,
redirectLocation}`. Redirects are not followed.

### `http-request` — call an API (any method)

```json
{
  "method": "POST",
  "url": "https://api.example.com/things",
  "json": { "name": "x" },
  "auth": { "type": "header", "name": "X-API-Key", "value": "…" }
}
```

`body` (string) or `json` (serialized for you, `content-type:
application/json`). Response: `{ok, finalUrl, status, contentType, headers
(allow-listed subset), body (parsed JSON when the response is JSON), truncated,
source}`. Non-GET requests **never follow redirects** — the 3xx is returned.
The service is stateless, so there is no idempotency replay: **callers must
not auto-retry non-GET requests**.

### Auth shapes

```json
{ "type": "bearer", "token": "…" }
{ "type": "basic", "username": "…", "password": "…" }
{ "type": "header", "name": "X-API-Key", "value": "…" }
```

Credentials are never logged, never echoed in errors, and are **dropped on
any redirect that leaves the original origin**. They cannot be passed via
plain `headers` (`authorization`/`cookie` are rejected there) — only via
`auth`, so the origin-drop protection always applies.

## Egress policy (SSRF defense)

Every hop of every request: http/https only, URL ≤ 2 000 chars; the hostname
is resolved and **every** resolved address must be public (private, loopback,
link-local/cloud-metadata, CGNAT, ULA, multicast and IPv4-mapped-IPv6 forms
are refused — the `cor:api:130:02` classifier, ported with its tests from
hadron-server); the connection is then **pinned** to the validated addresses
through a custom undici dispatcher lookup (SNI and Host keep the hostname),
closing the DNS-rebinding TOCTOU; redirects re-run the full check per hop
(max 3); one 30 s budget covers the whole chain *including the body read*;
response bodies are read streaming under a byte cap (truncate + flag, default
2 MB, hard cap 5 MB); only textual content types are returned.

## Other endpoints

- `GET /healthz`, `GET /readyz` — open; liveness/readiness.
- `GET /info` — bearer-gated; name, version, operation list.

## Development

```bash
npm install
npm run dev          # port 8080
npm test             # no network — fake fetch/DNS seams
npm run typecheck
```

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `WEBFETCH_TOOL_TOKEN` | production | Shared bearer for the ops plane. Boot refuses production without it. |
| `PORT` | no (8080) | Listen port. |
| `NODE_ENV` | no | `production` enables the boot refusal above. |

## Deployment

Komodo build → GHCR → `komodo_default`, internal-only (no Traefik route, no
public DNS) — hadron-server reaches it at `http://hadrontool-webfetch:8080`.
Secrets come from Doppler at runtime (the image bakes the Doppler CLI; Komodo
sets only `DOPPLER_TOKEN`). There is no database and no public ingress:
nothing to migrate, nothing to expose.

## License

MIT
