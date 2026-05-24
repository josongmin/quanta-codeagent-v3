# ADR-0148: Web search provider concrete impls (Brave primary + DuckDuckGo fallback)

> **Renumbered 2026-05-24** from sibling-of-0133 (`0133-hook-bidirectional-rpc.md` + `0133-document-tools.md` collision). User entry kept the original number; this slice moved to 0148.

- **Status**: Accepted
- **Date**: 2026-05-24
- **Related**: [[0127-web-tool-slice]] (closed-port `WebSearchProvider` introduced; no concrete provider shipped)
- **References**: `src/tool/web/providers/{brave.ts, duckduckgo.ts, index.ts}`, `src/tool/web/search.ts` (the consumer port), `tests/unit/tool/web-search-providers-hellgate.test.ts` (16 cases)

## 맥락

ADR-0127 landed the `web_search` tool plus the `WebSearchProvider` closed-port, but shipped **zero** concrete implementations. The current production behavior when a user invokes `web_search` is:

```
{ ok: false, output: "no web_search provider wired; configure via AgentConfig.webSearch" }
```

— byte-identical graceful degrade, but functionally the surface is dead until someone wires a provider. This ADR lands the first two providers so users can actually search.

## 결정

Two providers, both OPT-IN (no default registration — the host wires one into `AgentConfig.webSearch.provider`).

### Part 1 — `braveSearchProvider` (primary)

`src/tool/web/providers/brave.ts`. Closed-port impl backed by the Brave Search REST API (`https://api.search.brave.com/res/v1/web/search`).

- **Signature**: `braveSearchProvider(opts: BraveSearchOpts): WebSearchProvider`
- **Opts**: `{ apiKey: string, endpoint?, fetcher?, country? = "us", safesearch? = "moderate" }`
- **Header posture**: `X-Subscription-Token: <apiKey>` (NEVER in URL — keys must not leak to proxy/referrer logs), `Accept: application/json`, `Accept-Encoding: gzip`.
- **URL**: `${endpoint}?q=${enc(query)}&count=${clamp(limit,1,20)}&country=${country}&safesearch=${safesearch}`. `count` clamped both sides of the Brave-documented `[1,20]` range so a caller passing `0` or `9999` still issues a well-formed request.
- **Signal**: forwarded verbatim to `fetch` (only spread when defined to stay `exactOptionalPropertyTypes`-clean).
- **Error shape**: typed `BraveSearchError` (`{ status?, bodyExcerpt? }`) for non-2xx HTTP, JSON parse failures, and network failures. The `webSearchTool` boundary (ADR-0127) catches and converts to `ok:false`.
- **Graceful empty**: 200 response missing `web.results` (zero-match query, info-only answer) → `[]` (NOT an error).
- **No env reads**: the provider never touches `process.env`. The host (CLI / Web surface) sources `BRAVE_SEARCH_API_KEY` from env / OS keychain / vault and injects.

### Part 2 — `duckduckgoSearchProvider` (fallback, limited)

`src/tool/web/providers/duckduckgo.ts`. Backs onto the DuckDuckGo Instant Answer endpoint (`https://api.duckduckgo.com/?q=...&format=json`).

- **Signature**: `duckduckgoSearchProvider(opts?): WebSearchProvider`. No API key required.
- **Limitation called out in doc-comment**: "limited results — Instant Answer only, not full web search; prefer brave when you have an API key". DDG does not offer an official full search API; the IA endpoint returns curated topics (often 0) — a graceful empty-result outcome for the majority of programmer queries.
- **Mapping**: `RelatedTopics[*]` → `{ title (first ` – `-segment of Text), url (FirstURL), snippet (full Text) }`. Nested disambiguation groups (`Topics: [...]`) are flattened one level deep.
- **Error shape**: typed `Error("duckduckgo ...")` on network / non-2xx / parse failures. Same boundary-catch posture as Brave.

### Part 3 — Barrel

`src/tool/web/providers/index.ts` re-exports `braveSearchProvider`, `BraveSearchError`, `BraveSearchOpts`, `duckduckgoSearchProvider`, `DuckDuckGoSearchOpts`, `BRAVE_DEFAULT_ENDPOINT`, `DDG_DEFAULT_ENDPOINT`. Consumers:

```ts
import { braveSearchProvider } from "@/tool/web/providers"
// then wire into AgentConfig:
config.webSearch = {
  provider: braveSearchProvider({ apiKey: process.env.BRAVE_SEARCH_API_KEY ?? "" }),
}
```

DO NOT modify `src/tool/web/index.ts` or `src/tool/index.ts` — providers stay off the main barrel so hosts that don't want web search pull in no provider code at all (tree-shake friendly + concurrent sibling work safe).

## Default-OFF / registration

Unchanged from ADR-0127. `AgentConfig.webSearch` absent ⇒ `webSearchTool()` returns the "no provider wired" tool. This ADR adds **factories** the host can call; it does NOT auto-register them.

## Hellgate (16 cases)

`tests/unit/tool/web-search-providers-hellgate.test.ts` — fake `fetch` for every case, zero real network.

### A. braveSearchProvider (12 + 1 bonus)

1. happy: 200 JSON with 3 web.results → 3 `WebSearchHit`.
2. respects `limit`: 10 results, limit=3 → 3 returned.
3. `limit < 1` clamped to 1 in URL (`count=1`).
4. `limit > 20` clamped to 20 (`count=20`).
5. URL contains URL-encoded query (`q=hello%20world%20%26%20friends`) AND starts with `BRAVE_DEFAULT_ENDPOINT`.
6. API key travels in `X-Subscription-Token` header — NEVER in URL.
7. `country` / `safesearch` flow into URL.
8. `AbortSignal` forwarded verbatim to fetch.
9. 401 → throws `BraveSearchError` with `status === 401`.
10. 503 → throws `BraveSearchError` with `status === 503`.
11. malformed JSON → throws `BraveSearchError("parse-failed: ...")`.
12. missing `web.results` → empty array, no throw (graceful).
12b. network failure (`fetch` throws) → wrapped `BraveSearchError("network: ...")`.

### B. duckduckgoSearchProvider (4 + 1 bonus)

13. happy: `RelatedTopics` → mapped to hits; URL contains `format=json` + `no_html=1`.
14. empty `RelatedTopics` → `[]`.
14b. payload without `RelatedTopics` → `[]`.
15. `AbortSignal` forwarded.
16. network error → `Error("duckduckgo network: ...")`.
16b. nested `Topics[]` flattened one level deep.

## Alternatives rejected

1. **Google Programmable Search** — paid + complex auth (OAuth / API-key per project) + 100 free queries/day cap. Worse free-tier story than Brave.
2. **Bing Search v7** — Microsoft is **deprecating** the public Bing Search API (sunset announced 2025). Building on a deprecating surface is a non-starter.
3. **Self-hosted SearXNG** — deployment complexity (Docker / k8s) shifts the burden to the user. Could ship as a third provider later; out of scope for "first concrete impl".
4. **Scraping (Google / DDG HTML pages)** — TOS violations + brittle HTML + CAPTCHAs + IP bans. Never a serious option for an inference agent.
5. **Bundle the API key in this repo** — hard-no. The repo is OSS; keys must come from the host's env / vault.
6. **Read `process.env` inside the provider** — rejected. Provider must be pure and DI-able from any context (tests, Web surface, sandboxed worker). Env-reading is a host responsibility.
7. **Default-on Brave when env var is present** — rejected at THIS ADR (composition is the host's job; a future ADR-0134-ish "tier1 provider auto-selection" can sniff env and chain `brave → duckduckgo → none`).
8. **Re-export providers from `src/tool/web/index.ts`** — rejected. Would pull provider code into every consumer of the web barrel. Subdirectory `providers/` keeps the surface opt-in.

## Security posture

- **API key** is constructor-injected only; the provider never reads `process.env` and never logs the key.
- **Key transport**: header (`X-Subscription-Token`) — NEVER URL. Verified by hellgate test #6 (key must not appear in captured URL).
- **HTTPS only**: both endpoints default to `https://`. Caller-supplied `endpoint` override is the only way to use plain HTTP — same posture as `webFetchTool`'s `fetcher` injection (test-only seam).
- **No-throw at the tool boundary**: provider throws are caught by `webSearchTool` and converted to typed `ok:false` per ADR-0127 — no provider can crash the loop.
- **Body excerpt cap**: `BraveSearchError.bodyExcerpt` is capped at 200 chars (first non-empty line) so a megabyte HTML error page never gets stuffed into a log line.

## SOTA++ 자리매김

| Agent | Web search provider | Source open? | DI pattern | Provider count |
|---|---|---|---|---|
| Cursor | hard-coded server-side | ❌ closed | none | 1 |
| Claude Code 2.1 | hard-coded (Brave-suspected) | ❌ closed | none | 1 |
| v0.dev | hard-coded server-side | ❌ closed | none | 1 |
| Codex | none | n/a | n/a | 0 |
| **quanta (이전)** | none (port only) | ✅ open | closed-port DI | 0 |
| **quanta (본 ADR)** | Brave primary + DuckDuckGo fallback | ✅ open | closed-port DI | **2** |

= "first agent to ship a multi-provider, user-pluggable web search with both a primary keyed provider AND a no-key fallback". Other 3 agents ship one hard-coded backend baked into the inference layer; quanta lets the user own the backend choice + key surface.

## Follow-up

- **Tier1 multi-provider chain** — `src/agent/tier1/web-search.ts` could grow a provider-list seam (`providers: [brave, ddg]`) that tries each in order until one returns ≥1 hit. Separate ADR; this one ships the building blocks.
- **Provider auto-selection** — sniff `BRAVE_SEARCH_API_KEY` env in the composition root and chain `brave → ddg → none`. Host-layer concern.
- **Result re-ranking** — cross-provider de-dupe + re-rank by snippet/title similarity. Phase 2.
- **Response caching** — Brave usage quotas are tight on free tier; an LRU cache keyed by `(query, count)` would extend the runway. Belongs in tier1, not in the provider itself.
- **Third provider (SerpAPI / Tavily)** — same pattern, separate file. Drop into `src/tool/web/providers/<name>.ts` + export from the barrel.
- **`AgentConfig.webSearch.provider` to `AgentConfig.webSearch.providers[]`** — schema migration once we have ≥1 host actually chaining. Avoid premature ADR.
