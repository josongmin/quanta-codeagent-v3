# ADR-0160 — Connectors REST API (W7)

- **Status**: Proposed (2026-05-25)
- **Wave**: W7 of [[0130-extracted-source-absorption-roadmap]]
- **Related**: [[0155-mcp-skybridge]] (static stdio MCP — current state), [[no-heuristics-only-validated]]
- **References**: Codex Desktop `/aip/connectors` REST + Cursor OAuth dynamic registration + per-host availability + tool_settings — captured in memory `extracted-source-novel-findings-2026-05-24.md` R4

## Problem

Current state (`src/mcp/`) is **static stdio MCP**: each integration target requires a hand-curated stdio MCP server bin + config block. Three concrete gaps surface when integrating heterogeneous SaaS targets:

1. **No dynamic registry.** Adding a new connector requires editing source + a release. Codex Desktop exposes `/aip/connectors` GET, server-driven catalog.
2. **No OAuth dynamic discovery / registration.** Each new OAuth target requires hard-coding `authorize_endpoint`, `token_endpoint`, `client_id`. Cursor uses **RFC 8414** well-known discovery + **RFC 7591** dynamic client registration.
3. **No per-host availability probing.** Today, an unreachable connector silently fails on first call. Cursor probes host reachability up front + LRU-caches the verdict for 5 min.
4. **No mid-session token rotation seam.** Cursor's `RefreshGithubAccessTokenInBackgroundComposer` rotates GitHub tokens transparently mid-turn. Our `src/auth/chatgpt-oauth/refresh.ts` covers ChatGPT only; there is no general per-connector token store.

## Decision

Build a **connectors slice** at `src/connectors/` that sits **above** `src/mcp/` (does not modify it). Five phases A–E define a sealed surface: a REST-backed `ConnectorRegistryPort`, RFC-8414/7591 OAuth discovery + registration, an availability prober with LRU + degraded-recovery, and a per-connector token store.

```
┌─────────────────────────────────────────────────────────────┐
│  src/connectors/   (NEW — this ADR)                         │
│   ├─ types.ts                    : ports + closed unions    │
│   ├─ availability.ts             : AvailabilityCheckerPort  │
│   ├─ rest-registry.ts            : REST adapter (24h cache) │
│   ├─ in-memory-registry.ts       : test impl                │
│   ├─ oauth-discovery.ts          : RFC 8414 well-known      │
│   ├─ oauth-registration.ts       : RFC 7591 dynamic client  │
│   ├─ availability-prober.ts      : HEAD + DNS, LRU 5min     │
│   └─ token-rotation.ts           : TokenStorePort + rotate  │
└─────────────────────────────────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  src/mcp/   (EXISTING — UNCHANGED)                          │
│   stdio MCP client + skybridge passthrough                  │
└─────────────────────────────────────────────────────────────┘
```

### Phase A — Connector model + ports (types.ts, availability.ts)

```ts
// Closed union (OCP: addition forces compile-error sweep)
type SupportedAuth = "oauth" | "none"

interface Connector {
  readonly id: string                // stable within ONE registry snapshot
  readonly displayName: string
  readonly host: string              // canonical reachable host (for availability)
  readonly auth: SupportedAuth
  readonly oauthIssuer?: string      // present iff auth === "oauth"
  readonly tags?: ReadonlyArray<string>
}

interface ConnectorRegistryPort {
  list(): Promise<ReadonlyArray<Connector>>
  get(id: string): Promise<Connector | undefined>
  refresh(): Promise<RefreshOutcome>   // typed outcome: "fresh" | "cached-degraded"
}

interface AvailabilityCheckerPort {
  probe(host: string): Promise<AvailabilityVerdict>  // typed: ok | dns-fail | http-fail
}
```

### Phase B — REST registry (rest-registry.ts, in-memory-registry.ts)

`createRestConnectorRegistry({ fetchPort, baseUrl, clockPort, cachePort })`:
- GET `{baseUrl}/connectors`, parses typed list.
- **24h positive cache** (RFC-8414 well-known has the same SHOULD; we mirror).
- On 5xx / network failure: serve stale cache + return `cached-degraded` from `refresh()`. **Honesty contract**: caller can branch on outcome.
- `cachePort` (file-backed in prod, in-memory in test) so DI is symmetric.

`createInMemoryConnectorRegistry(connectors)`: testing impl, returns the seeded list verbatim.

### Phase C — OAuth discovery + dynamic registration

`discoverOAuthEndpoints(issuer, fetchPort)`:
- GET `{issuer}/.well-known/oauth-authorization-server` (RFC 8414).
- Fallback GET `{issuer}/.well-known/openid-configuration` (OIDC discovery).
- Typed result: `{ authorizeEndpoint, tokenEndpoint, registrationEndpoint? }` or `OAuthDiscoveryError` with stable `code` arm.

`registerOAuthClient(registrationEndpoint, metadata, fetchPort)`:
- POST RFC 7591 `client_metadata` body, returns `{ clientId, clientSecret?, registrationAccessToken? }`.
- Validates required response fields up front; throws typed `OAuthRegistrationError`.

### Phase D — Availability prober (availability-prober.ts)

`createAvailabilityProber({ fetchPort, dnsPort, clockPort, lruSize? })`:
- HEAD request to `https://{host}/`, 3s timeout (HTTP/1.1 RFC default).
- DNS A/AAAA lookup as fallback signal (some servers reject HEAD).
- **LRU 5min TTL** (matches Cursor's observed window) — verdict cached per host.
- Closed verdict arm: `"ok" | "dns-fail" | "http-fail" | "timeout"`.

### Phase E — Token rotation (token-rotation.ts)

`TokenStorePort`:
```ts
interface TokenStorePort {
  read(connectorId: string): Promise<TokenRecord | undefined>
  write(connectorId: string, record: TokenRecord): Promise<void>
  delete(connectorId: string): Promise<void>
}
```

`createTokenRotator({ tokenStore, fetchPort, clockPort })`:
- `rotate(connectorId, refresh)`: invokes the supplied `refresh` callback, persists `TokenRecord` atomically (write-then-fsync via store).
- **In-flight mutex per connectorId** — concurrent rotate calls coalesce to one network call (mirrors `src/auth/chatgpt-oauth/refresh.ts` invariant added in [[chatgpt-oauth-impl-2026-05-23]]).
- File-backed adapter: `~/.quanta/connectors/{id}.json`, mode 0600 (Phase 1; OS Keychain Phase 2).

## Invariants preserved

1. **[[no-heuristics-only-validated]]** — all timeouts/TTLs are RFC-anchored:
   - 24h registry cache: RFC 8414 §4 (`max-age=86400` recommended)
   - 5min availability LRU: matches Cursor observed window (file:line anchor in memory R4)
   - 3s HEAD timeout: HTTP/1.1 RFC 9112 conservative default
2. **Backward compat** — `src/mcp/` is **untouched**. Existing stdio MCP path continues unchanged. Connectors slice is **additive**, default-OFF (no auto-wire into agent loop in this ADR; that is a follow-up).
3. **Closed-port discipline** ([[branch-search-adr0083]]) — every external dep is a typed port (`fetchPort`/`dnsPort`/`clockPort`/`cachePort`/`tokenStore`). Slice has **zero** import-time coupling to `node:fs`/`node:net`/`fetch`.
4. **Typed-error arms** — no untyped throws; every failure has a stable `code` for caller branching without string matching ([[may-22-quanta-wins-hellgate-verification]] pattern).
5. **Hellgate mandatory** — 5 hellgate batteries (≥10 adversarial cases each) seal the surface before any agent-loop wire.

## SOLID adherence

- **SRP**: each file is one responsibility (registry / discovery / registration / probe / rotate). No file >250 LOC target.
- **OCP**: `SupportedAuth` + verdict arms + error codes are closed unions. Adding an auth scheme forces sweep across all switches.
- **LSP**: every port (RegistryPort / AvailabilityCheckerPort / TokenStorePort / fetchPort / dnsPort / cachePort / clockPort) is substitutable — test impls vs prod impls share no nominal types.
- **ISP**: ports are minimal — `list`/`get`/`refresh` separate, `read`/`write`/`delete` separate. No god interfaces.
- **DIP**: all I/O (HTTP, DNS, clock, fs, cache) flows through injected ports. No `import "node:fs"` at slice top-level.

## Test plan (Phase F)

**Hellgate** (5 files, ≥10 cases each = 50+ adversarial):
- `connector-registry-rest-hellgate.test.ts` (REST adapter: stale-cache fallback, 5xx, timeout, malformed JSON, empty list, host case-fold, refresh idempotence, in-flight refresh dedupe)
- `oauth-discovery-hellgate.test.ts` (8414 happy, fallback to OIDC, malformed JSON, missing fields, 404 both endpoints, registration endpoint optional)
- `oauth-registration-hellgate.test.ts` (7591 happy, missing client_id, 400 with error body, non-JSON response, request body shape verify)
- `connector-availability-hellgate.test.ts` (LRU hit/miss/expire, DNS fail, HEAD timeout, HEAD 405 fallback to GET, concurrent probe coalesce)
- `connector-token-rotation-hellgate.test.ts` (rotate happy, in-flight mutex, fs write failure, missing token, atomic write-then-fsync, delete idempotence)

**Unit** (5 files, ≥8 cases each):
- types/ports compile, in-memory registry, fake fetch port behavior, cache port semantics, prober LRU eviction.

**Feature catalog**: 5 yamls under `tools/feature-catalog/features/09-integration/`.

## Tradeoffs

- **No OAuth flow execution in this ADR** — only discovery + registration. The authorize/redirect/exchange flow is `src/auth/chatgpt-oauth/`'s pattern; generalizing it across many connectors is a follow-up ADR (depends on this slice landing first).
- **No agent-loop wire-up** — this ADR seals the slice. Wiring into tool dispatch / permission stack is a follow-up; landing surface separately keeps blast radius small.
- **File-backed token store, not Keychain** — Phase 1. ChatGPT OAuth has the same posture ([[chatgpt-oauth-impl-2026-05-23]]). Keychain is a separate ADR when the desktop surface lands.
- **24h registry cache is long** — but it matches RFC 8414 §4 SHOULD. Manual `refresh()` is always available; we trade staleness for HTTP politeness.

## Out of scope (explicitly deferred)

- Agent-loop / tool-dispatch wire-up — separate follow-up ADR.
- OAuth authorize/redirect flow — generalize from `src/auth/chatgpt-oauth/` once needed.
- OS Keychain — Phase 2 alongside desktop surface.
- WebSocket / SSE streaming connectors — REST first; streaming when first concrete connector needs it.
- Per-tool `tool_settings` schema introspection (Cursor R4 finding) — captured here as future work; out of scope for this slice's hellgate.
