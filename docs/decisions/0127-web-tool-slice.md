# ADR-0127: `web_fetch` + `web_search` tool slice (web 가용성 갭 봉합)

- **상태**: Accepted
- **날짜**: 2026-05-24
- **관련**: ADR-0125 (turn-diff caller-wired idiom), ADR-0126 (read_image — same default-OFF posture, deferred registration)
- **참조**: `src/tool/web/` (fetch.ts / search.ts / index.ts), `src/agent/tier1/web-search.ts`, `src/agent/types.ts` (webSearch slot + FeaturesConfig 갱신), `src/tool/index.ts` (barrel), `tests/unit/tool/web-fetch-hellgate.test.ts` (24 cases), `tests/unit/tool/web-search-hellgate.test.ts` (17 cases)
- **SOTA 참조**: Cursor (built-in web), Claude Code 2.1 (`WebFetch` + `WebSearch`), v0.dev (web). Codex는 built-in web 없음 (가장 마지막). **quanta**는 vision (ADR-0126) 직후, modern coding agent 중 두 번째로 마지막으로 web 도구가 없는 상태였음.

## 맥락

agent는 unfamiliar API docs / SDK reference / changelog / RFC text를 조회해야 할 때가 잦다. 오늘은 `bash`로 `curl`을 셸링하는 수밖에 없다 — HTML→text 변환 없음, 도메인 안전성 없음, 응답 크기 캡 없음, content-type 식별 없음. 비교 대상 modern agent (Cursor / Claude Code / v0)는 모두 web 도구를 가지고 있고, 그것이 "이 모델이 모르는 SDK를 만났을 때" 첫 번째 도구다.

vision 흡수 직후 (ADR-0126) 두 번째 universal 갭을 닫는다.

## 결정

본 ADR은 **2-part + 1-builder** 흡수다 (둘 다 default-OFF 보존 invariant).

### Part 1 — `web_fetch` (always-on, `src/tool/web/fetch.ts`)

`webFetchTool(options?: { fetcher?: typeof fetch })`. provider 없음 — production caller는 `webFetchTool()`로 `globalThis.fetch`를 묶고, 테스트는 fake `fetch`를 inject한다.

- `name: "web_fetch"` / `isReadOnly: () => true` / `isConcurrencySafe: () => true` / no `hitlTier` (read-only는 dispatch infer로 "none")
- `inputSchema`:
  - `url: z.string().url().refine(u => u.startsWith("https://"))` — TLS 강제
  - `maxBytes?: z.number().int().positive().max(5_000_000).optional()` — 기본 1 MB, 상한 5 MB
- **Security posture** (`WebFetch` 동일):
  - 비-`https:` 프로토콜 거절 (`http:`, `file:`, `data:`, …)
  - SSRF denylist — 26 prefix (literal host string match, NO DNS resolution): `localhost` / `127.` / `0.0.0.0` / `10.` / `172.16.`–`172.31.` (16 entries) / `192.168.` / `169.254.` (AWS IMDS 포함) / `::1` / `fc00:` / `fd00:`
  - 응답 크기 캡 — **streaming chunk loop** (response body reader)로 누적 byte가 `maxBytes` 초과하면 즉시 abort+truncate. 전체 body를 buffer해서 자르는 게 아니므로 GB-scale 200 응답에도 OOM 없음.
  - 바이너리 content-type 거절 — `image/*` / `audio/*` / `video/*` / `application/octet-stream` / `application/pdf` / `application/zip` / `application/gzip` / `application/x-tar` → ok:false "non-text content (use dedicated tool)". 모델은 base64 텍스트로 이미지를 못 "본다" — `read_image`가 그 surface.
- **HTML→Markdown** (inline, zero new deps):
  1. `<script>`/`<style>` 블록 전체 strip
  2. `<h1..6>` → `#…######`
  3. `<a href="X">Y</a>` → `[Y](X)`
  4. `<code>X</code>` → `` `X` ``
  5. `<br>` / `</p>` / `</div>` / `</li>` → newline
  6. 남은 tag strip
  7. 5 named entity + `&apos;` + `&nbsp;` decode
  8. 3+ consecutive `\n` → exactly 2
  9. trim
  변환 함수는 `htmlToMarkdown(html)`로 export되어 hellgate가 fake fetcher 없이 pure 변환을 테스트.
- **Output**:
  ```
  URL: <final>
  Status: <code>
  Content-Type: <ct>
  Length: <bytes> bytes[ (body truncated to cap)]

  <markdown or text>
  ```
  최종 50_000자에서 `(truncated, N more chars)` suffix.
- **No-throw**: 모든 실패 (schema parse / aborted / invalid URL / non-https / SSRF deny / fetch error / non-2xx / binary CT / oversize / body read error)가 typed `ok:false` `ToolResult`.

### Part 2 — `web_search` (provider-gated, `src/tool/web/search.ts`)

`webSearchTool(provider?: WebSearchProvider)`. provider 없이 호출되면 graceful ok:false ("no web_search provider wired"). closed-port DI — concrete provider (Brave / DuckDuckGo / Bing / SerpAPI / …)는 composition root가 `AgentConfig.webSearch.provider`로 wire.

- `name: "web_search"` / `isReadOnly: () => true` / `isConcurrencySafe: () => true`
- `inputSchema`:
  - `query: z.string().min(1).max(500)`
  - `limit?: z.number().int().positive().max(20).optional()` — 기본 5
- **Port**:
  ```ts
  interface WebSearchHit { readonly title: string; readonly url: string; readonly snippet: string }
  interface WebSearchProvider {
    search(query: string, limit: number, signal?: AbortSignal): Promise<readonly WebSearchHit[]>
  }
  ```
- **No-throw**: provider가 throw하면 `ok:false "provider error: <msg>"` (절대 loop으로 escape하지 않음).
- **Output** (numbered, snippet 200자 truncate, 입력 순서 보존):
  ```
  N results for "<query>":

  1. <title>
     <url>
     <snippet…>

  2. ...
  ```
- **graceful degrade**: provider 없을 때 surface가 registry에 남아 있어도 crash 없이 typed `ok:false`. 호스트는 "이 모델 세션은 web 검색이 없다"를 prompt에서 advertise할 수 있다.

### Part 3 — Tier-1 builder + AgentConfig slot + barrel

- `src/agent/tier1/web-search.ts` — `buildWebSearchBlock(config)`은 `config.webSearch?.provider`가 있을 때 `[webSearchTool(provider)]`, 없으면 `[]` (byte-identical default-OFF, RFC §1.2).
- `src/agent/tier1/index.ts` — `buildWebSearchBlock` 추가.
- `src/agent/types.ts` — `AgentConfig.webSearch?: { provider: WebSearchProvider }` slot (top-level — 미래 citation surface가 query history를 inspect할 수 있도록 nested 아님), `FeaturesConfig`에 `"webSearch"` literal-key 추가.
- `src/tool/index.ts` — `web*` 클러스터 export (factory / schema / type / 상수).

## Default-OFF (registration is caller-wired)

ADR-0126의 deferred-caller-wire idiom을 그대로. 본 ADR은 **slice surface가 존재하도록** 박는다:

- `web_fetch`: `webFetchTool()` factory가 barrel에 export. `buildDefaultTools()`에는 **박지 않음** — `MUTATING_TOOL_TABLE` (사용자 in-flight, `src/agent/mode.ts`) entry와 atomic하게 들어가야 하므로. `shadow*` / `read_image`와 동일 패턴. 미래 1-line PR:
  1. `src/agent/mode.ts`의 `MUTATING_TOOL_TABLE`에 `web_fetch: null` 추가.
  2. `buildDefaultTools()`에 `webFetchTool() as Tool` 추가.
- `web_search`: `tier1/web-search.ts`가 `config.webSearch?.provider`로 게이팅. 호스트가 provider를 wire하지 않는 한 등록되지 않음. legacy session은 byte-identical.

## Hellgate (41 cases / 87 expects, all green)

### `tests/unit/tool/web-fetch-hellgate.test.ts` (24 cases)

- **A. Metadata** (4): name / isReadOnly / isConcurrencySafe / no hitlTier
- **B. Input validation** (4): `{}` / http:// / file:/// / maxBytes > 5MB
- **C. SSRF defense** (5): localhost / 127.0.0.1 / 10.0.0.5 / 192.168.1.1 / 169.254.169.254
- **D. Mocked fetch** (5): 200 text/html happy / 404 / binary content / oversize stream / network throw
- **E. htmlToMarkdown** (7): heading / link / script-strip / style-strip / entity decode / newline collapse / inline code
- **F. Abort** (1): pre-aborted signal

### `tests/unit/tool/web-search-hellgate.test.ts` (17 cases)

- **A. Metadata** (3): name / isReadOnly / isConcurrencySafe
- **B. No-provider degrade** (1): provider 없으면 typed ok:false
- **C. Input validation** (3): `{}` / empty query / limit > 20
- **D. Provider routing** (3): args 전달 검증 / 0 hits / throw → ok:false
- **E. Output formatting** (3): 1-hit shape / snippet 200자 truncate / multi-hit 순서
- **F. Signal forwarding** (2): ctx.signal 그대로 / pre-aborted → provider 미호출

총 41 tests, 87 expects, 0 fail.

## Alternatives rejected

1. **Hard-coded provider (Brave / DuckDuckGo built-in)** — 거절. user가 backend 선택을 통제해야 함 (API key surface도 user 영역). closed-port DI가 정답.
2. **3rd-party HTML→Markdown lib (turndown, html-to-md)** — 거절. dep 늘리면 slice fence가 무거워짐. inline 130 LOC로 충분 (heading / link / code / br / p / div / li / 5 entity). 미래 corner case (table)는 inline 확장 또는 lib swap 결정.
3. **HTTP (non-S) 허용** — 거절. TLS 강제 (Claude Code `WebFetch`와 동일). MITM/eavesdrop 위험 + 모델이 plaintext 응답을 신뢰하지 않도록.
4. **SSRF allowlist** (반대 방향) — 거절. allowlist는 유용한 도메인을 차단 (PyPI / npm / GitHub / RFC editor 모두 등록 필요). denylist는 위험만 차단 + 그 외 전부 통과 — Claude Code도 동일 posture. DNS-resolution-aware verification은 미래 ADR (현재는 static prefix match).
5. **Synchronous body buffer (cap 후 substring)** — 거절. 200 status로 GB body 보낼 수 있는 서버 (proxy / mirror / video) → OOM 위험. streaming chunk loop이 정답.
6. **dispatch.ts 또는 buildDefaultTools에서 직접 등록** — 거절. `MUTATING_TOOL_TABLE` 사용자 in-flight 영역. ADR-0126과 동일 deferred-caller-wire idiom. 미래 1-line PR.
7. **`hitlTier: "always-confirm"` 강제** — 거절. `web_fetch`는 공개 URL 조회로 `Read` of a public file과 등가. 모델이 매 fetch마다 confirm을 요구받으면 UX 파괴. 매 호스트가 명시적으로 opt-in (`hitl.enabled`) 후 분류로 결정.
8. **Provider absent 시 throw** — 거절. graceful degrade가 SOTA++ posture. 호스트가 web을 wire하지 않은 상태에서 모델이 `web_search`를 호출하면 typed ok:false로 "no provider wired" — model이 즉시 다른 전략으로 pivot.

## SOTA++ 자리매김

| Agent | web_fetch | web_search | HTML→MD | SSRF defense | Provider DI |
|---|---|---|---|---|---|
| Cursor | built-in | built-in | server-side | server-side | hard-coded |
| Claude Code 2.1 | `WebFetch` | `WebSearch` | partial | denylist | hard-coded (Brave?) |
| v0.dev | built-in | built-in | server-side | server-side | hard-coded |
| Codex | ❌ | ❌ | n/a | n/a | n/a |
| **quanta (이전)** | **none** (bash curl만) | **none** | n/a | n/a | n/a |
| **quanta (본 ADR)** | `web_fetch` | `web_search` | inline (0 dep) | denylist 26 prefix | **closed-port DI** |

= "Codex 다음으로 마지막 web 갭 봉합. closed-port DI + local default-OFF graceful + zero-dep HTML→MD + 정직한 streaming cap + SSRF denylist를 모두 갖춘 첫 구현". 다른 3사는 provider를 hard-code (그들의 inference backend 일부로 박힘) — quanta는 user-controlled.

## Security posture

- **TLS-only**: http://, file://, data:// 등은 URL parse 후 protocol check에서 거절.
- **SSRF denylist (26 prefix)**: loopback (4) + RFC1918 private (18) + link-local (1) + IPv6 loopback/ULA (3). DNS resolution은 안 함 — `evil.example.com → 10.0.0.1`은 통과. 향후 DNS-aware ADR 후속.
- **Response cap (1 MB default, 5 MB ceiling)**: streaming, OOM-free.
- **Binary-type reject**: 8 prefix (image/audio/video + 5 application/*). 모델은 base64 텍스트로 이미지 못 봄 → `read_image` 안내.
- **provider DI**: 키 관리는 user 책임. quanta는 provider 구현을 ship하지 않음.

## Follow-up

- **defaultTools에 web_fetch 추가 (1-line)**: `MUTATING_TOOL_TABLE`에 `web_fetch: null` 추가하고 `buildDefaultTools()`에 `webFetchTool() as Tool` append. 사용자 in-flight 정착 후 별도 ADR.
- **`image_url` 도구**: `web_fetch`로 fetch + `Content-Type: image/*`면 `read_image` style로 base64-encode해서 `ToolResult.images`에 attach. Phase 2.
- **Default provider impl (Brave / DuckDuckGo / SerpAPI)**: 각각 별도 ADR. opt-in adapter 모듈로 `npm install @quanta/web-search-brave` 같은 sibling 패키지가 user 영역.
- **DNS-resolution-aware SSRF**: 현재는 literal-host match. DNS resolve 후 결과 IP가 private range면 reject — Claude Code도 안 함 (TOCTOU 위험 vs static deny의 단순성). 본격 production deployment 시 reconsider.
- **PDF text extraction (Phase 3)**: `application/pdf` 현재 reject. 미래 PDF→text 변환은 `read_pdf` 별도 도구 (별 의존성).
- **Robots.txt 준수**: 현재는 검사 안 함. 본격 crawl 시나리오는 별도 도구가 가져야 함 (`web_fetch`는 1-page lookup).
