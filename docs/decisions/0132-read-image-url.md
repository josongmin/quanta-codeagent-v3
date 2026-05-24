# ADR-0132: `read_image_url` 도구 — URL → vision 파이프라인 (read_image + web_fetch 합성)

- **상태**: Accepted
- **날짜**: 2026-05-24
- **관련**: ADR-0126 (`read_image` — magic-byte SSOT + 5 MB cap), ADR-0127 (`web_fetch` — SSRF denylist + https-only), ADR-0125 (helper-only deferred wire idiom)
- **참조**: `src/tool/image/from-url.ts`, `tests/unit/tool/read-image-url-hellgate.test.ts` (17 cases)
- **SOTA 참조**: Cursor 스크린샷은 local-only, Codex `view_image`도 local-only, Claude Desktop은 paste/drop UI. **modern coding agent 중 direct URL → vision 도구를 가진 곳은 없음** — quanta가 첫 구현.

## 맥락

`read_image` (ADR-0126)는 로컬 디스크의 이미지만 다루고, `web_fetch` (ADR-0127)는 텍스트만 다룬다 (binary content-type은 거절). 사용자가 "이 GitHub 이슈 스크린샷 / Figma 미리보기 / 외부 URL 이미지를 봐줘"라고 요청하면 표현할 도구가 없다. 두 도구를 LLM이 2-step으로 chain하는 것도 불가능 (web_fetch가 image를 reject). URL → vision은 자연스러운 합성이지만 현재 명시적 surface가 없다.

## 결정

`read_image_url`은 두 ADR의 SSOT를 **재사용**하는 thin composer 도구다. 합성하되 새 의미를 만들지 않는다:

- 매직-바이트 sniffer + 5 MB cap (4 mediaType closed set) — `sniffMediaType` / `MAX_IMAGE_BYTES` import from `./read` (ADR-0126 SSOT).
- https-only + SSRF denylist — `web_fetch` (ADR-0127)와 동일한 26-prefix literal-host 거절 정책.
- 무손실 출력 — `ImageBlock` payload는 `read_image`와 동일 shape (`{type:"image", data:<base64>, mediaType}`).

### Slice posture

`src/tool/image/from-url.ts`만 추가. imports only:
- `zod` (input schema)
- `./read` (sniffer + cap SSOT — DRY)
- `../types` (Tool/ToolContext/ToolEvent/ToolResult/ImageBlock indirect)
- `@/llm` (ImageBlock — `read_image`와 동일 의존도)

### SSRF 정책 — duplicated denylist (intentional DRY-violation)

`web_fetch`의 `ssrfDeny` predicate가 **export되지 않음** + 본 ADR이 sibling tool 슬라이스 (`src/tool/web/`)를 수정하지 않는 round 제약. 따라서 26-prefix 배열을 inline duplicate. **드리프트 위험은 명시적으로 인정**:

- 두 리스트는 ADR-0127 commit 시점에서 byte-identical로 시작.
- 미래의 `@/security/ssrf` (또는 동등) 공유 레이어가 `isPrivateOrLoopbackHostname(host)`를 노출하면, 두 도구 모두가 import하는 형태로 consolidate. 이는 별도 ADR.
- 그동안은 reviewer가 PR에서 두 리스트를 cross-check하는 convention. drift는 보안 사고이므로 lint rule을 박는 대신 ADR이 hazard를 surface.

### Tool spec

| field | value |
|---|---|
| `name` | `"read_image_url"` |
| `description` | "Fetch an HTTPS image URL and attach it to the model's view via tool_result. Same media-type policy as read_image (magic-byte SSOT, 5 MB cap, png/jpeg/webp/gif). SSRF-defended (rejects http://, file://, and private/loopback addresses)." |
| `isReadOnly()` | `true` |
| `isConcurrencySafe()` | `true` |
| `hitlTier` | (omitted — read-only는 dispatch infer로 "none") |
| input | `{ url: z.string().url() }` |

### Execution pipeline

1. schema parse — fail → ok:false "invalid input"
2. `ctx.signal.aborted` check — fail → ok:false "aborted before start"
3. URL parse — fail → ok:false "invalid URL"
4. protocol check — non-`https:` → ok:false "only https:// allowed"
5. SSRF — denied host → ok:false "SSRF denied" + `failure: {mode:"permission_denied", path:hostname, isReadonly:false}`
6. `fetcher(url, {signal, redirect:"follow"})` — throw → ok:false "fetch failed"
7. `res.ok` check — non-2xx → ok:false `HTTP <status>` + `failure: {mode:"error", modelVisibleError:"http_<n>"}`
8. body → `Uint8Array` via `res.arrayBuffer()`
9. cap — `length > MAX_IMAGE_BYTES` → ok:false "image too large"
10. magic-byte sniff — `null` → ok:false "unsupported or unrecognized media type"
11. base64 + return:
    ```ts
    {
      ok: true,
      output: `Fetched image: ${url} (${mediaType}, ${bytes.length} bytes)`,
      images: [{ type: "image", data: <base64>, mediaType }],
    }
    ```

### Default-OFF (registration deferred — atomic-with-mode-table)

`read_image` / `web_fetch`와 동일 패턴: tool factory가 `from-url.ts`에서 export되지만, **`buildDefaultTools()`에 등록하지 않음**. `src/agent/mode.ts`의 `MUTATING_TOOL_TABLE`에 entry를 추가하는 PR과 atomic하게 들어가야 함 (sibling-touched). 본 ADR은 surface 자체만 박는다.

본 ADR은 `src/tool/image/index.ts` / `src/tool/index.ts` barrel도 **건드리지 않음** — 그 두 파일은 동시 진행 중인 sibling round의 책임 영역. 호출자가 `import { readImageUrlTool } from "@/tool/image/from-url"`로 직접 import 가능 (factory 노출됨).

## Hellgate (17 cases, all green)

`tests/unit/tool/read-image-url-hellgate.test.ts`:

- **A. Metadata** (3): name / isReadOnly / isConcurrencySafe
- **B. Schema** (2): `{}` / `{url:"not-a-url"}` 거절
- **C. URL safety** (4): http://, localhost, 127.0.0.1, 192.168.1.1
- **D. Happy** (4): PNG / JPEG / WebP / GIF — `ok:true`, `images.length===1`, mediaType 정확, base64 round-trip
- **E. Sad** (3): 404 / >5MB body / non-image bytes
- **F. Signal** (1): `ctx.signal`이 fetcher init에 forward

총 17 tests, 0 fail. 모든 네트워크 I/O는 `{fetcher}` DI seam으로 mock.

## Alternatives rejected

1. **`read_image`를 확장해 URL도 받기** — 단일 도구의 surface bloat. LLM이 명시적 이름 (`read_image_url` vs `read_image`)을 선택할 수 있어야 의도-tool 매칭이 명확해진다. 하나의 도구가 두 도메인 (FS + network)을 가지면 path safety / SSRF / size cap이 한 코드에서 뒤섞임.
2. **`web_fetch` → `read_image`로 LLM이 2-step chain** — `web_fetch`가 binary content-type을 명시적으로 reject한다 (ADR-0127). 우회하려면 web_fetch의 content-type 정책을 약화시키거나 LLM이 base64 데이터 URI를 텍스트로 받아 다시 디코드하는 우스꽝스러운 경로가 필요. 명시적 composer tool이 훨씬 단순/빠름.
3. **>5MB 이미지 자동 downsize** — `read_image`와 동일 posture: Phase 2 (Sharp/Jimp dep 추가는 slice fence를 깬다, 정직한 reject가 SOTA).
4. **SSRF predicate를 `web_fetch`에서 export해 import** — 본 ADR이 sibling 슬라이스를 수정할 수 없는 round 제약 (`src/tool/web/fetch.ts` is sibling-owned). intentional duplicate + 미래 consolidation을 ADR에 명시.
5. **streaming chunk loop으로 OOM 방지 (web_fetch 패턴 그대로)** — image는 5 MB cap이 hard limit이므로 `arrayBuffer()` 후 cap check도 동일한 안전성 (5 MB는 OOM 위협이 아님). 코드 단순화 우선. 미래의 capacity bump가 50 MB+로 가면 streaming 변환 필요.
6. **content-type 헤더로 mediaType 결정** — 매직-바이트 SSOT 원칙 (ADR-0126). 서버가 `Content-Type: image/png`로 거짓말한 JPEG 바이트도 정직하게 분류돼야 함. content-type은 hint, 매직 바이트가 enforcer.
7. **DNS-resolution-aware SSRF** — `web_fetch`와 동일 posture. literal-host 매치만. `evil.example.com → 10.0.0.1` 회피 시나리오는 미래 ADR (resolver dep + 비동기 DNS 호출).

## SOTA++ 자리매김

| Agent | URL → vision 도구 | base64 | magic-byte 강제 | SSRF defense | size cap |
|---|---|---|---|---|---|
| Cursor | ❌ (screenshot UI only) | n/a | n/a | n/a | n/a |
| Codex | ❌ (`view_image` local-only) | n/a | n/a | n/a | n/a |
| Claude Desktop | ❌ (paste/drop UI) | n/a | n/a | n/a | n/a |
| Claude Code | ❌ | n/a | n/a | n/a | n/a |
| **quanta (본 ADR)** | `read_image_url` | ✅ | ✅ (4-type closed) | ✅ (26-prefix) | ✅ (5 MB) |

= "modern coding agent 중 direct URL → vision의 첫 직접 도구. read_image (vision) + web_fetch (network)의 명시적 SSOT 재사용 + intentional SSRF duplicate (consolidate는 별도 ADR)."

## Security posture

- **TLS 강제**: `https:` only. `http:` / `file:` / `data:` / ... 거절.
- **SSRF denylist**: 26 literal prefix — loopback / RFC1918 / link-local (incl. AWS IMDS) / IPv6 loopback / IPv6 ULA. DNS 미해석 (`evil.example.com → 10.0.0.1`은 회피 가능; 미래 ADR).
- **5 MB cap**: Anthropic vision raw-byte ceiling. body read 후 typed length로 cap check.
- **Magic-byte SSOT**: content-type 헤더 신뢰 안 함. 4 시그니처 (PNG/JPEG/WebP/GIF)만 통과.
- **No-throw**: 모든 실패 경로가 typed `ok:false` ToolResult.
- **Signal forwarded**: `ctx.signal`이 `fetcher(url, {signal})`로 그대로 forward — turn 중단 시 in-flight HTTP 즉시 abort.

## Follow-up

- **Dispatch / mode-table registration** — `MUTATING_TOOL_TABLE`에 `read_image_url: null` + `buildDefaultTools()`에 추가하는 1-line PR. `read_image` / `web_fetch`와 atomic하게.
- **`image_data_url` variant** — `data:image/png;base64,...` 인라인 URI를 받는 도구. 사용자가 클립보드/CLI에서 직접 paste한 base64를 일급 surface로. 새 도구 (네트워크 surface 없음 → SSRF 무관, schema도 다름).
- **Animated GIF first-frame extraction** — `read_image`의 Phase 3와 동일. provider가 정적 frame만 받으면 그때 추가.
- **SSRF helper consolidation** — `@/security/ssrf`에 `isPrivateOrLoopbackHostname(host)` + 26-prefix SSOT 박고 `web_fetch` / `read_image_url` 모두 import하도록 refactor. 별도 ADR (sibling 슬라이스 modify 필요).
- **DNS-resolution-aware SSRF** — `evil.example.com → 10.0.0.1` 같은 회피 차단. 비동기 resolver dep + latency cost trade-off. 별도 ADR.
- **Auto-downsize >5MB** — `read_image` Phase 2와 동일 (Sharp/Jimp dep).
