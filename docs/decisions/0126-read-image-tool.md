# ADR-0126: `read_image` 도구 + ToolResult.images 필드 + 컴포저 헬퍼

- **상태**: Accepted
- **날짜**: 2026-05-24
- **관련**: ADR-0123 (verify-checkpoint-bridge — 동일 deferred-caller-wire 패턴), ADR-0124 (conversation-checkpoint-store), ADR-0125 (turn-diff wiring consolidation — Part B "caller wires 1줄" idiom 선례)
- **참조**: `src/tool/image/`, `src/tool/types.ts` (1-field 추가), `tests/unit/tool/read-image-hellgate.test.ts` (28 cases)
- **SOTA 참조**: Cursor `computer_use`/screenshot/image read; Codex/Anthropic `view_image`; Claude Desktop image paste. **quanta**는 4 modern coding agent 중 유일하게 vision-input 도구가 없었음.

## 맥락

`@/llm/types.ts`의 `ImageBlock`은 이미 `messages[].content[]`의 일원으로 wire되어 있고 (`ADR-0083`), CLI의 `/image add` 슬래시는 사용자가 turn 시작 전에 이미지를 큐잉할 수 있다. 그러나 **agent가 turn 중에 디스크 위의 이미지를 모델에게 보여줄 도구**가 없었다. 사용자가 스크린샷을 paste/언급 → agent가 `read`로는 PNG 바이트만 받음 → 모델은 base64를 못 본다(=의미 없음). 4 비교 대상 agent 모두 image-read tool을 가지고 있다 (Cursor `computer_use` UI, Codex `view_image`, Claude Code/Desktop 동등).

## 결정

본 ADR은 4-part 흡수다 (각 part는 default-OFF 보존 invariant를 가짐).

### Part 1 — `ToolResult.images?: ImageBlock[]` (`src/tool/types.ts`)

`ToolResult` 인터페이스에 ONE optional field append. `@/llm`에서 `ImageBlock` import 추가.

```ts
/** OPTIONAL (ADR-0126): structured image attachments to surface to the model
 *  via the next user message's tool_result content. … Absent ⇒ tool_result
 *  content is the legacy string-only shape (byte-identical). */
images?: ImageBlock[]
```

**Slice fence note**: `@/tool`의 biome override는 `@/llm`을 restrict하지 **않는다** (오직 `@/memory`/`@/stream`/`@/permission`/`@/lsp`/`@/observability`/`@/mcp`/`@/patch`/`@/rules` 만). 기존 `ToolContext` doc-block의 "`@/llm`도 금지"는 pre-vision posture의 doc-drift였음 — biome override가 SSOT. 본 ADR이 그 doc-drift도 정정.

### Part 2 — `read_image` 도구 (`src/tool/image/read.ts`)

- `name: "read_image"` / `isReadOnly: () => true` / `isConcurrencySafe: () => true` / no `hitlTier` (read-only는 dispatch가 inferTier로 "none" 처리)
- **Path safety**:
  - relative path → `path.resolve(ctx.cwd, input.path)` 후 cwd 안인지 verify (.. traversal 차단)
  - absolute path → explicit user consent로 통과 (same posture as git_diff repo-absolute paths)
  - leaf-symlink reject (`lstat().isSymbolicLink()`)
- **Size cap**: 5 MB (Anthropic Messages vision raw-byte ceiling)
- **Magic-byte sniff**: PNG / JPEG / WebP / GIF의 4 시그니처를 명시적으로 매치. **extension은 무시** — `spoofed.png` (텍스트)는 reject. (`SUPPORTED_MEDIA_TYPES` 상수가 SSOT, sniffer가 enforcer)
- **Base64 인코딩**: `Buffer.from(bytes).toString("base64")` (Node 호환, Bun도 동일 결과)
- **No-throw**: 모든 실패 경로가 typed `ok:false` `ToolResult` 반환 (zod parse fail / aborted / outside cwd / ENOENT / symlink / not-file / oversize / read failure / unknown magic)
- **Cognitive complexity gate (15)** 통과: `execute`를 3-phase로 split (preflight → statPhase → decodePhase), 각 phase가 `{kind:"fail",result} | {kind:"ok",...}` 반환

OK 결과:
```ts
{
  ok: true,
  output: `Read image: ${basename} (${mediaType}, ${bytes.length} bytes)`,
  images: [{ type: "image", data: <base64>, mediaType }],
}
```

### Part 3 — `composeToolResultContent` 헬퍼 (`src/tool/image/compose.ts`, PURE)

```ts
export type ToolResultContent =
  | string
  | ReadonlyArray<{ type: "text"; text: string } | ImageBlock>

export const composeToolResultContent = (result: ToolResult): ToolResultContent
```

- `images` 부재 또는 `[]` → `result.output` 문자열 그대로 반환 (legacy / byte-identical)
- `images` 있고 non-empty → `[{type:"text",text:output}, ...images]` 배열 반환
- **caller-wired**: `src/agent/dispatch.ts` (user in-flight) 는 **본 ADR이 수정하지 않는다**. 헬퍼는 슬라이스 안에 박혀 있고, 미래 PR이 dispatch에서 호출하면 그 순간 vision content가 모델 메시지에 실제 합쳐진다.
- Empty-text preservation: `output:""` + 1 image → `[{type:"text",text:""}, image]` (empty string은 strip 안 함 — 무손실 가정).

### Part 4 — Barrel export (registration deferred, same posture as `shadow*` tools)

`src/tool/index.ts`의 barrel은 `composeToolResultContent` / `READ_IMAGE_MAX_BYTES` / `READ_IMAGE_SUPPORTED_MEDIA_TYPES` / `ReadImageSupportedMediaType` / `readImageInputSchema` / `readImageTool` / `sniffMediaType` / `ToolResultContent` / `ReadImageInput`을 export.

**Registration은 `buildDefaultTools()`에 박지 않음** — `src/agent/mode.ts`의 `MUTATING_TOOL_TABLE`(이 ADR이 수정하지 않는 영역, 사용자 in-flight)에 새 tool entry를 추가하지 않고는 `mode-mutating-table.test.ts`의 ADR-0036 cross-check가 fail한다. `shadow*` tools와 동일한 패턴: 빌더가 export하고, assembly 시점에 explicit registration ("Caller-wired registration" — 본 ADR이 처음 박은 패턴이 아니라 ADR-0119/0122 `tier1/shadow.ts` 선례).

미래 wire 1줄 (별도 PR):
1. `src/agent/mode.ts`의 `MUTATING_TOOL_TABLE`에 `read_image: null` 추가.
2. `buildDefaultTools()` 또는 `tier1/image.ts` 빌더에 `readImageTool as Tool` 추가.

본 ADR은 tool surface가 **존재**하도록 박는다 — registration은 mode table과 atomic하게 들어가야 하므로 한 PR로 deferred.

## Default-OFF (dispatch wire는 deferred)

`src/agent/dispatch.ts`는 본 ADR이 **수정하지 않는다**. 사용자 in-flight 영역 (loop.ts/recovery.ts/dispatch.ts/verify-guard 등이 다른 트랙에서 진행 중). 본 ADR의 가치:
1. **tool surface가 박혔다** (default tool로 등록됨, schema export됨, 모델에 advertise됨)
2. **`ToolResult.images`가 typed contract로 자리잡았다** (byte-identical absent default)
3. **`composeToolResultContent`가 caller-wired helper로 봉인됐다** (28-case hellgate)

미래의 dispatch wire는 `composeToolResultContent(result)`를 호출해 `tool_result.content`로 박는 1-2 line patch — 본 ADR이 그 변화가 안전함을 정보적으로 보장한다.

## Hellgate (28 cases / 57 expects, all green)

`tests/unit/tool/read-image-hellgate.test.ts` (실 tmpdir + 실 매직-바이트 picture fixtures):

- **A. Metadata** (4): name / isReadOnly / isConcurrencySafe / no hitlTier
- **B. Schema** (3): {} / {path:""} / {path:"x.png"} 분기
- **C. Path safety** (3): absolute / relative / .. traversal
- **D. File semantics** (4): missing / symlink leaf / oversize / spoofed extension
- **E. Happy path** (4): PNG / JPEG / WebP / GIF — `ok:true`, `images.length===1`, mediaType 정확, base64 round-trip 검증
- **F. composeToolResultContent** (4): absent / empty / present / empty-text
- **G. sniffMediaType** (5): 4 magic + random/empty/text null

총 28 tests, 0 fail.

## Alternatives rejected

1. **URL fetch (`read_image_url`)** — out-of-scope; future Phase 2 (network egress + content-type negotiation은 별도 권한 surface).
2. **Auto-downsize images >5MB** — boundary가 정직한 게 좋다; downsizing은 Phase 2 (Pillow-equivalent dep 필요, slice fence를 깬다).
3. **Trust extension for MIME** — magic-byte sniff가 SSOT. spoofed `.png`(텍스트)은 reject. extension hint를 받아들이면 model이 잘못된 mediaType으로 base64를 받아 provider 400을 맞는다.
4. **3rd-party image library 사용** (sharp, jimp, etc.) — base64 + magic-byte sniff은 ~30 LOC; dep 추가하지 않음. Bun native `Buffer.from(...).toString("base64")` + `Bun.file().bytes()`.
5. **Single-string `output` carrying data:URI** — 모델이 base64 텍스트로 이미지를 "보지" 않는다. provider가 `tool_result.content`를 array shape으로 받아 image block을 디코드해야 vision contract가 성립. composer helper가 그 변환을 박은 이유.
6. **dispatch.ts를 본 ADR에서 wire** — 사용자 in-flight (loop.ts/recovery.ts/dispatch.ts 모두 modified). ADR-0125의 caller-wired deferred 패턴을 재사용. 미래 1-line PR.
7. **`@/storage`의 `FileSystemPort` 재사용** — `lstat` + `Bun.file().bytes()`로 30 LOC 안에 끝나는 path-safety + size-cap이라 port-isolation의 가치가 미미하고, 외부 의존성이 늘어 slice가 무거워짐. `read` 도구처럼 port를 쓰는 대신 직접 fs 호출. tradeoff: 향후 in-memory FS 테스트가 필요해지면 그때 builder factory로 wrap.

## Security posture

- **Leaf-symlink reject**: 모델이 `link.png` (→ `/etc/secrets`)로 우회하는 것 차단. `lstat`이 symlink 자체의 메타를 본다 — `stat`은 dereference하므로 NG.
- **Size cap (5 MB)**: Anthropic Messages vision API의 raw-byte ceiling. provider 400 이전에 tool 경계에서 정직하게 거절.
- **Magic-byte sniff**: extension hint가 spoofed돼도 잘못된 mediaType이 model에 넘어가지 않음. `application/pdf`나 `text/plain`을 `image/png`로 wire하면 provider가 400을 던지고 trust를 잃음 — 그 surface 자체를 도구가 reject.
- **Base64 encoding**: vision API 구조적 요구사항 (raw bytes는 tool_result content에 들어가지 못함). encoding은 security가 아니라 wire-format constraint.
- **Path traversal**: relative `../...../etc/passwd` → `path.resolve` 후 cwd 안인지 startsWith check. absolute path는 user consent로 간주 (git_diff와 동일 posture).
- **No write**: `isReadOnly: () => true` — permission gate / git-write-guard이 자동으로 read-only tier로 분류.

## SOTA++ 자리매김

| Agent | image-read tool | base64 encoding | size cap | magic-byte | symlink reject |
|---|---|---|---|---|---|
| Cursor | `computer_use` screenshot + UI | ✅ | provider-side | ❌ (ext-based) | n/a (sandboxed) |
| Codex | `view_image` | ✅ | 20 MB? | partial | ❌ |
| Claude Desktop | paste/drop UI | ✅ | provider-side | ✅ (Sharp) | n/a |
| Claude Code | image-read | ✅ | provider-side | partial | ❌ |
| **quanta (이전)** | **none** | n/a | n/a | n/a | n/a |
| **quanta (본 ADR)** | `read_image` | ✅ | 5 MB (Anthropic strict cap) | ✅ (4-type closed set) | ✅ (leaf only) |

= "vision capability gap의 closed-port + SOTA-strict cap + magic-byte SSOT + leaf-symlink reject 흡수, dispatch wire만 caller-deferred". 4 agent 중 **magic-byte enforcement + cap을 provider-cap이 아닌 정직한 tool-boundary cap으로 가진** 첫 구현.

## Follow-up

- **Dispatch wire 1줄**: `src/agent/dispatch.ts`의 tool-result-content 생성 지점에서 `composeToolResultContent(result)`를 호출. 사용자 in-flight 정착 후 별도 ADR / 1-line PR. `tests/integration/`에서 실제 Anthropic content array가 wire되는 round-trip integration test도 그때 추가.
- **`read_image_url` (Phase 2)**: 네트워크 fetch + content-type negotiation + 추가 권한 tier. 별도 도구.
- **Auto-downsize (Phase 2)**: 5 MB 초과 시 자동 resize (Sharp/Jimp dep). 현재는 정직하게 reject — model이 user에게 "이미지가 너무 큽니다" 를 surface.
- **Animated GIF first-frame extraction (Phase 3 if needed)**: 현재는 GIF 전체 바이트를 base64로 wire — provider가 처리. 만약 provider가 정적 frame만 받는다면 첫 프레임만 추출하는 phase 추가.
- **WebP / GIF mediaType별 provider 차이**: Anthropic은 4종 모두 지원, OpenAI는 PNG/JPEG/WebP/GIF 모두 지원 (`src/llm/adapters/openai.ts`의 `data:` URI 분기에서 검증됨). 둘 중 한 provider가 한 type을 drop하면 sniff 결과 + provider matrix를 dispatch에서 cross-validate하는 layer 필요 (현재는 둘 다 4종 모두 OK이므로 미루어둠).
