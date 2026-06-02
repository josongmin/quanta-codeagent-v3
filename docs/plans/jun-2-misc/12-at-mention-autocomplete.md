# RFC: CLI 입력의 `@`-mention 자동완성 드롭다운 (기존 mention 백엔드 활성화)

- **Status**: Draft (implementation-ready)
- **Author**: architecture
- **Date**: 2026-06-02
- **ADR (제안)**: ADR-0439 (`docs/decisions/`의 최신은 `0434-permission-profile-list-select.md` — 다음 free 번호. 0435는 `07-...`과 같은 sprint의 `01-mcp-auto-restart` RFC가 선점)
- **Slice**: `@/apps/cli` (신규 leaf `src/apps/cli/at-autocomplete/` + `raw-line-reader.ts` 훅) + 신규 listing 어댑터 (composition root에서 주입)
- **Default-OFF**: `@`-trigger 미주입 ⇒ 오늘 `readLine` 동작 **byte-identical** (슬래시 팔레트/히스토리/heredoc/멀티바이트 모두 불변)
- **흡수 출처**: Codex webview `at-mention-list-*.js` / `anchored-autocomplete-overlay-*.js` / `inline-mentions-*.js`, Claude Code CLI `@file:`/`@workspace:`/`src/x.ts:42` 라인 참조 (정확한 file은 §1)

---

## 1. 배경 — 경쟁사 `@`-mention UX (흡수 대상)

### 1.1 Codex Desktop (webview)

전부 `/Users/songmin/quanta-codeagent-v3/.extracted_source/codex/webview/assets/`.

- `at-mention-list-QIt8fzMH.js` / `at-mention-list-acW2mHgN.css` — `@` 입력 시 떠오르는 **kind-grouped 후보 리스트**. 파일/심볼/명령이 한 드롭다운에 섹션으로 묶여 표시되고, 각 행은 아이콘 + 이름 + 부가설명(경로/시그니처).
- `anchored-autocomplete-overlay-B57el4IT.js` — 후보 리스트를 **커서 위치에 anchor**시키는 오버레이 포지셔너 (캐럿 좌표 기준 띄움). webview/DOM 전용 — TTY에는 직접 흡수 불가(§4.4의 TTY 포지셔닝으로 대체).
- `inline-mentions-lWDEHK5E.js` / `inline-mention-style-KuiVYF4p.js` / `inline-mentions-tMX9kki0.css` — accept 후 입력란 안에 **mention을 inline chip**으로 렌더(토큰화된 시각 표현). TTY는 chip 렌더가 불가하므로 우리는 원시 `@target` 텍스트를 그대로 유지(§4.6).

흡수하는 것: (a) `@` 트리거 → 후보 리스트, (b) kind-grouped 표시, (c) 타이핑으로 인플레이스 필터, (d) ↑↓ 선택 / Tab·Enter accept. **흡수하지 않는 것**: DOM 오버레이 포지셔너, inline chip 토큰화(둘 다 webview 전용).

### 1.2 Claude Code CLI

`/Users/songmin/quanta-codeagent-v3/.extracted_source/claude-code-cli/_cli-symbols.txt`:

- `:42659` — `["@root:", @file:, ""]` / `@workspace:` — Claude는 `@`-mention을 **namespaced prefix**(`@file:`, `@workspace:`, `@root:`)로 라우팅한다.
- `:115179` — `Custom file suggestion configuration for @ mentions` — `@` 입력 시 **파일 경로 제안**이 1급 기능.
- `:112271-112274` — `extractMcpResourceMentions` / `extractAtMentionedFiles` / `extractAgentMentions`, `:109674` `at_mentioned`, `:112250` `parseAtMentionedFileLines` — 제출 시 `@`-멘션을 파싱해 파일/MCP-resource/agent로 추출하고, `parseAtMentionedFileLines`로 **`path:line` 라인 참조**까지 해석한다.

흡수하는 것: (a) `@`로 **파일 경로 완성**, (b) `path:line` 라인 참조(우리 parser는 이미 `@src/foo.ts` 파일 멘션을 알지만 `:42` 라인 suffix는 §4.7에서 확장), (c) 제출 시 텍스트에서 멘션 추출(우리는 이미 `parseMentions`로 보유 — §2).

### 1.3 무엇이 "delightful"한가

세 경쟁사의 공통 디자인 신호:
1. **퍼지 필터** — 부분 문자열/서브시퀀스로 좁혀짐(정확 prefix만이 아님).
2. **kind-grouped** — 파일/심볼/스킬/플러그인/앱이 섞이지 않고 묶여 보임.
3. **라인 참조** — `@path:line`으로 특정 줄을 가리킴.
4. **zero-friction** — `@` 한 글자로 즉시 열리고, 타이핑이 곧 필터.

quanta의 차별점: 우리 parser(§2)는 이미 **5-kind**(`skill|plugin|app|file|symbol`)를 deterministic 우선순위 cascade로 분류하므로, 드롭다운만 붙이면 경쟁사보다 **넓은 kind 커버리지**를 TTY에서 제공한다.

---

## 2. 현재 quanta — 백엔드는 **있고**, 입력 표면만 안 붙음

이 RFC의 핵심 프레이밍: **신규 기능이 아니라 활성화(wire)다.** mention 백엔드는 이미 완성되어 있고, **이미 agent 루프에 연결까지 되어 있다.** 빠진 것은 오직 **CLI 입력란의 `@`-자동완성 UX** 하나다.

### 2.1 백엔드는 완성 — 그리고 이미 와이어됨

`src/agent/mention-injection/`의 closed-port surface (`index.ts:24-53`):

- `parseMentions(userInputText: string): readonly ParsedMention[]` — 순수/NO-THROW 5-kind 파서 (`parser.ts:251`). 5 sigil: `@skill` / `plugin://name` / `@@app` / `@path/to/file`·`@foo.ts` / `@FooBar`·`@MyClass.method` (`parser.ts:4-10`). deterministic cascade: slash→file, uppercase→symbol, lowercase+dot→file, lowercase-kebab→skill (`parser.ts:183-189`).
- `MentionKind = "skill" | "plugin" | "app" | "file" | "symbol"` (`types.ts:50`).
- `ParsedMention { kind, target, span:{start,end}, raw }` (`types.ts:59-74`). `target`은 sigil 제외(예: `@code-review` ⇒ `code-review`).
- `MentionResolverPort` (`resolver.ts:58-68`) — async, kind-dispatched. `resolveSkill/Plugin/App` 필수 + `resolveFile?/resolveSymbol?` 옵션. **target→body 한 방향**(target 주면 bodyText 렌더). **enumerate(후보 나열) 능력은 없음** — 이게 §4의 신규 포트가 필요한 이유.
- `buildInjectionFragments(mentions, resolver): Promise<InjectionFragment[]>` (`resolver.ts:140`) — 병렬 resolve, unresolved skip.
- `buildMentionInjectionMessages(fragments): Message[]` (`inject-messages.ts:64`) — fragment당 `<mention kind=… target=…>…</mention>` user-role 메시지 1개, `embedUntrusted`로 defang.

resolver **어댑터**도 이미 존재: `@/agent/plugin-app-resolver`의 `createCompositeMentionResolver` (`index.ts:30`)가 skill/plugin/app/file 4-kind을 묶고, `createFileResolver({root,maxBytes,tailRatio})` (`file-resolver.ts:39-51`)가 fs-jail 파일 resolve, `createLspSymbolLookup`/`createSemanticSymbolLookup` (`mention-injection/index.ts:36-44`)가 symbol resolve를 제공.

**가장 중요한 정정** (사용자 가설 "백엔드는 있지만 안 붙음"의 일부는 *이미 닫혀 있음*): mention 백엔드는 단순히 만들어진 게 아니라 **agent 루프가 이미 소비 중**이다.

```ts
// src/agent/loop.ts:1028-1040
const resolveMentionInjectionMessages = async (config, wm) => {
  if (config.mentionInjector === undefined) return []         // :1032
  const userText = latestUserTextFromWm(wm)
  if (userText === undefined || userText.length === 0) return []
  try { return await config.mentionInjector(userText) }       // :1036  <- 여기서 호출
  catch { return [] }
}
```

그리고 `cfg.mentionInjector`는 `installCodexR2Wires` (`codex-r2-wire-install/install.ts:227-236`, `buildMentionInjector` `:137-162`)가 채운다. 이 closure는 내부에서 `parseMentions(userInputText)` → `buildInjectionFragments` → `emitMentionEvents` → `buildMentionInjectionMessages`를 **이미 호출**한다 (`install.ts:146-155`). composition root도 이미 호출 중: `apps/agent/assemble.ts:361`, `apps/agent/run.ts:141`, `apps/cli` 경유 `host/runtime/internal/mention-wire.ts:43`.

> 즉, **사용자가 입력란에 `@src/foo.ts`를 손으로 타이핑해 제출하면, 그 멘션은 오늘도 이미 resolve되어 프롬프트에 주입된다** (resolver가 주입된 경우). 백엔드 wire는 닫혀 있다.

### 2.2 그러나 입력 표면(CLI)에는 `@`-자동완성이 전혀 없다

`src/apps/cli/raw-line-reader.ts`가 입력을 읽는 방식: Bun의 `node:readline`이 `completer` 옵션을 호출하지 않으므로(`raw-line-reader.ts:1-8` 주석), 이 모듈은 **raw-mode `keypress` 이벤트**를 직접 읽고 완성 UX를 자체 렌더한다 (`readline.emitKeypressEvents(stdin)` + `setRawMode(true)` `:201-203`, `onKey` 핸들러 `:472-691`).

자동완성이 이미 구현된 유일한 트리거는 **슬래시 `/`**다:

```ts
// raw-line-reader.ts:206-221  refreshCandidates()
state.candidates = state.buf.startsWith("/") ? opts.completer(state.buf) : []  // :211
state.listOpen = state.candidates.length > 0                                    // :215
```

즉 후보 리스트는 **`buf.startsWith("/")`일 때만** 채워진다(`:211`). `@`는 어떤 분기에서도 트리거되지 않는다. `completer`/`describe`는 `prompt-pipeline.ts:84-85`에서 `slashCompleter`/`describeSlashCommand`만 받는다.

`slashCompleter`(`slash-engine.ts:42-46`)도 `line[0] !== "/"`면 즉시 `[[], line]` 반환 — `@`와 무관.

**제출 경로엔 `parseMentions` 호출이 없다(입력 표면 기준).** `grep -rn "parseMentions" src/apps/cli/` ⇒ **0 hits**. CLI 표면은 raw 텍스트를 그대로 `localPayload`(`prompt-pipeline.ts:159-174`)로 만들어 turn으로 흘릴 뿐, 입력 시점에 멘션을 인지하지 못한다. (실제 파싱은 §2.1처럼 **agent 루프**가 뒤늦게 `mentionInjector`로 한다.)

### 2.3 그래서 정확한 갭

| 항목 | 상태 | 근거 |
|---|---|---|
| 5-kind 파서 | ✅ 있음 | `parser.ts:251` |
| resolver 포트 + 어댑터 (skill/plugin/app/file/symbol) | ✅ 있음 | `resolver.ts:58`, `plugin-app-resolver/index.ts`, `symbol-lookup-lsp.ts` |
| inject 빌더 + agent-loop 소비 | ✅ **이미 wire됨** | `loop.ts:1036`, `install.ts:146-155` |
| **후보 enumerate(나열) 능력** | ❌ 없음 | resolver는 target→body 단방향(`resolver.ts:58-68`) |
| **CLI `@`-trigger 드롭다운** | ❌ 없음 | `raw-line-reader.ts:211` `/`만 트리거 |
| **`@path:line` 라인 suffix** | ❌ 없음 | parser는 `@src/foo.ts`만, `:42` 미지원(`parser.ts:97`) |

이 RFC는 ❌ 3개를 닫는다.

---

## 3. Goals / Non-goals

### Goals
- CLI 입력란에서 **`@` 입력 시 자동완성 드롭다운**을 띄운다 — 5개 `MentionKind`(skill/plugin/app/file/symbol) + 파일 경로 완성.
- 후보를 **kind-grouped + 퍼지 필터 + ↑↓ 선택 + Tab/Enter accept + Esc dismiss**로 제공(Codex/Claude 흡수).
- accept된 멘션이 제출 시 기존 `parseMentions` → `mentionInjector` 경로를 **그대로 라운드트립**(우리는 `@target` 텍스트를 그대로 삽입하므로 백엔드는 무변경).
- **`@path:line` 라인 참조**를 파서에 확장(Claude `parseAtMentionedFileLines` 흡수).
- **후보 enumerate 포트**(`AutocompleteProvider`)를 신규 정의 — kind별 어댑터가 기존 resolver/LSP 백엔드를 재사용해 *나열*한다(resolve는 그대로).
- 기존 `readLine` UX(슬래시 팔레트, 히스토리, reverse-i-search, heredoc, ghost-text, 멀티바이트 width) **무회귀**.
- **Default-OFF**: `@`-provider 미주입 ⇒ `readLine` byte-identical. 신규 테스트로 봉인.
- 모든 비동기 resolve/list는 **주입된 provider**로 — 테스트에 실제 TTY/fs/LSP 0개.

### Non-goals
- **GUI / webview 오버레이** ❌ (`anchored-autocomplete-overlay-*.js`는 DOM 전용; TTY 포지셔닝으로 대체).
- **inline chip 토큰화** ❌ (`inline-mentions-*.js`; TTY는 raw `@target` 텍스트 유지).
- **full LSP 인덱싱 / 백그라운드 심볼 워밍** ❌ — symbol 후보는 기존 `workspaceSymbol(query)`(`symbol-lookup-lsp.ts:16`) on-demand, 미설정 시 graceful empty.
- **새 퍼지 알고리즘 발명** ❌ — 기존 idiom(`slash-engine.ts:44`의 prefix/sort, `tool/edit/fuzzy.ts`의 ladder) 재사용/확장. 임의 점수 휴리스틱 금지.
- **MCP-resource 멘션**(Claude `extractMcpResourceMentions`) ❌ — 우리 5-kind enum 밖(확장은 ADR-0418 supersede 필요, `types.ts:47-48`). §8 후속.
- **slash 팔레트와의 통합 UI** ❌ — `@`와 `/`는 독립 트리거(서로 byte-identical 격리).

---

## 4. 설계 — closed-port

### 4.1 두 축의 분리: enumerate(나열) vs resolve(렌더)

핵심 관찰: 기존 `MentionResolverPort`는 **target → body** 한 방향(`resolver.ts:58-68`). 자동완성은 반대 방향 — **부분 쿼리 → 후보 목록**이 필요하다. `SkillRegistryReadOnly`(`plugin-app-resolver/types.ts:20-22`)도 `lookup(name)` 정확 조회만 있고 `list()`가 없다.

따라서 **신규 포트 `AutocompleteProvider`를 정의**한다(resolve 포트는 무변경). resolve는 accept 후 제출 경로에서 기존 백엔드가 그대로 한다 — 자동완성은 *나열만* 책임진다.

```ts
// src/apps/cli/at-autocomplete/port.ts
import type { MentionKind } from "@/agent/mention-injection"

/** 자동완성 후보 1개. `insertText`는 입력란에 삽입될 raw 텍스트(sigil 포함,
 *  예: "@src/foo.ts" / "@code-review" / "plugin://github"). `label`은 표시용,
 *  `detail`은 dim 우측 컬럼(경로/시그니처/설명 첫줄). */
export interface AtCandidate {
  readonly kind: MentionKind
  readonly insertText: string   // 입력란에 그대로 삽입 (제출 시 parseMentions가 다시 파싱)
  readonly label: string        // 드롭다운 표시 이름
  readonly detail?: string      // dim 우측 힌트
  readonly score?: number       // provider가 매긴 랭킹(있으면 정렬 키; §4.5)
}

/** 부분 쿼리(@ 이후 타이핑된 텍스트, sigil 제외) → kind별 랭킹된 후보.
 *  async: 파일 glob / LSP workspaceSymbol I/O가 필요. NO-THROW(구현이
 *  throw하면 wire 레이어가 빈 배열로 강등 — §6.1). signal로 취소 가능. */
export interface AtCandidateProvider {
  /** kind를 명시하지 않은 "raw" 쿼리. provider가 query 형태로 kind를 추론
   *  (parser cascade 미러: '/' 포함→file, 대문자 시작→symbol, …) 후 묶어 반환.
   *  반환은 kind별로 그룹 가능한 평면 배열(렌더가 §4.4에서 그룹핑). */
  list(query: string, signal?: AbortSignal): Promise<readonly AtCandidate[]>
}
```

### 4.2 kind별 어댑터 — 기존 백엔드 재사용

`AtCandidateProvider`의 합성 구현은 kind별 sub-provider를 묶는다. 각 sub-provider는 **나열 능력만** 추가하고 렌더는 기존 resolver에 위임하지 않는다(detail은 가벼운 메타만).

| kind | 나열 소스 (재사용) | detail |
|---|---|---|
| `file` | `fast-glob` 미사용 — 기존 `@/tool/file-tree-summary` 워크스페이스 walker 또는 `fs.readdir` 기반 prefix walk(cwd jail은 `createFileResolver`의 `root`와 동일 `is-path-inside`, `file-resolver.ts:35`) | 상대경로 |
| `symbol` | `createLspSymbolLookup({provider,cwd,anchorFile})` (`symbol-lookup-lsp.ts:34-45`)의 `workspaceSymbol(query)`; 미설정/anchor 없음 ⇒ `[]` (graceful, `symbol-lookup-lsp.ts:18-20`) | `path:line` 시그니처 |
| `skill` | **신규** `SkillRegistryReadOnly`에 `list(prefix?)` 추가가 필요 — 현재 `lookup`만(`types.ts:20-22`). 어댑터는 옵션 `listSkills?: () => readonly {name,description}[]`를 주입받음(미주입 ⇒ `[]`) | description 첫줄(`skill-resolver.ts:29-34`의 `firstLineOf` 재사용) |
| `plugin` | 주입 `listPlugins?: () => readonly {name,description}[]` (plugin registry) | description 첫줄 |
| `app` | 주입 `listApps?: () => readonly {name,description}[]` (app catalog) | description 첫줄 |

> 설계 정직성: skill/plugin/app은 **나열 소스가 코드에 아직 없다**(`lookup`만 존재). 그래서 어댑터는 모두 *옵션 주입*으로 받고, 미주입 시 빈 배열 → 그 kind는 후보 0개(graceful). 1차 범위에서 가장 ROI 높은 **file + symbol**부터 실접속하고, skill/plugin/app은 registry `list()`가 노출되면 즉시 켜진다(default-OFF seam).

```ts
// src/apps/cli/at-autocomplete/provider.ts
export interface CompositeAtProviderDeps {
  readonly cwd: string
  readonly fileRoot: string                      // = createFileResolver root와 동일
  readonly symbolLookup?: SymbolLookupLspPort     // createLspSymbolLookup(...)
  readonly listSkills?: () => readonly { name: string; description: string }[]
  readonly listPlugins?: () => readonly { name: string; description: string }[]
  readonly listApps?: () => readonly { name: string; description: string }[]
  readonly maxPerKind?: number                    // default 8 (= MAX_VISIBLE_CANDIDATES, raw-line-reader.ts:131)
  readonly fuzzy?: (query: string, candidates: readonly string[]) => readonly { value: string; score: number }[]
}
export const createCompositeAtProvider = (deps: CompositeAtProviderDeps): AtCandidateProvider => { /* … */ }
```

### 4.3 keypress 상태 머신 (raw-line-reader 통합)

`@`-자동완성은 기존 슬래시 팔레트와 **같은 State 필드 일부를 공유하되 독립 모드**로 동작한다. 신규 `State` 필드(default 비활성 ⇒ byte-identical):

```ts
// raw-line-reader.ts State 확장 (모두 default 비활성)
atActive: boolean        // @-드롭다운이 떠 있나
atTriggerPos: number     // buf 안의 '@'(sigil) 위치(span 시작). accept 시 [atTriggerPos, cursor) 교체
atQuery: string          // @ 이후 현재 타이핑된 부분(파생값; 매 키마다 재계산도 가능)
atCandidates: readonly AtCandidate[]
atSelectedIdx: number
```

상태 전이(슬래시 모드보다 **우선순위 낮음** — `searchMode`/heredoc이 활성이면 `@`는 일반 문자):

```
            (idle, buf 편집중)
                 │  '@' 입력 AND 좌-boundary OK(§4.3a) AND provider 주입됨
                 ▼
            AT_OPEN  ── 타이핑 ──▶ atQuery 갱신 → provider.list(atQuery) (debounced/async)
              │  ▲                                       │
              │  └───────────── 후보 도착 ──────────────┘ (race-safe: §6.1 epoch)
   ┌──────────┼───────────────────────────────────────────────┐
   │ ↑/↓      │ atSelectedIdx 순환 (atCandidates.length 기준)     │
   │ Tab/Enter│ accept: buf[atTriggerPos..cursor) := insertText  │ → AT_CLOSED
   │ Esc      │ dismiss (buf 무변경)                              │ → AT_CLOSED
   │ Space/구분│ '@query'가 후보 alphabet 벗어남 ⇒ 자동 dismiss    │ → AT_CLOSED
   │ Backspace│ '@'까지 지우면 dismiss; 아니면 atQuery 축소+재조회 │
   └──────────┴───────────────────────────────────────────────┘
```

**4.3a 좌-boundary**: `@`는 입력 시작 또는 비-단어문자 뒤에서만 트리거(parser rule 6 미러, `parser.ts:104-107` `isLeftBoundaryOk`). 즉 `foo@`(이메일류)는 트리거 안 함 — 코드/식별자 중간의 `@` 오발동 방지(§6).

### 4.4 TTY 드롭다운 렌더 (kind-grouped)

기존 `renderListRows`(`raw-line-reader.ts:247-264`)는 슬래시 후보용 2-컬럼(cyan 이름 + dim desc). `@`-드롭다운은 **kind 섹션 헤더**를 추가:

```
› refactor the @src/ut▏                                   ◀ input row(커서 ▏)
  openai · gpt-5 · ~/proj                                 ◀ meta row

  file                                                    ◀ kind 헤더(dim)
    src/util.ts          124 lines                        ◀ 선택(reverse+cyan)
    src/utils/log.ts     38 lines
  symbol
    Utf8Decoder          src/codec.ts:91
```

- 기존 band 예약/scroll-stability 메커니즘(`growBandTo`/`releaseBand`/`reserved` `:233-334`)을 **그대로 재사용** — `targetReserved()`(`:223-231`)에 `@`-리스트 행 수를 더하는 분기만 추가.
- `MAX_VISIBLE_CANDIDATES=8`(`:131`) 동일 cap, kind 헤더 포함 시 `+kind수`만큼만 늘림(터미널 높이 초과는 §6의 "+N more" 패턴, `:262`).
- 멀티바이트 width는 기존 `stringColumns`/`charColumns`(`:103-129`)로 정렬 — 한글/CJK 후보도 정확히 컬럼 정렬.
- 색: 이름 `CYAN`, detail `GRAY`, 선택 `REVERSE`(전부 기존 상수 `:94-98`).

### 4.5 퍼지 랭킹 — 기존 idiom 재사용 (신규 휴리스틱 금지)

`no-heuristics-only-validated` 메모리 지침에 따라 **새 점수식을 발명하지 않는다.** 두 단계:

1. **1차(기본)**: 슬래시 완성과 동일한 **prefix 매치 + 정렬**(`slash-engine.ts:44` `.filter(startsWith).sort()`). 결정적·검증됨.
2. **2차(opt-in)**: provider deps의 `fuzzy?` 콜백이 주입되면 서브시퀀스 매치 사용. **재사용 후보**: `tool/edit/fuzzy.ts`는 *라인-윈도우 edit*용이라 부적합. 대신 (a) `slash-engine`의 prefix를 1차로, (b) 부분문자열 `includes` 매치를 2차로 fallback하는 보수적 2-tier(둘 다 결정적). 별도 점수 가중치는 **도입하지 않음** — `score`는 "매치 tier(0=prefix, 1=substring) + 원래 인덱스"의 안정 정렬 키로만 사용.

> 정직성: 코드베이스에 일반 문자열 퍼지 매처(fzf류 서브시퀀스 스코어러)는 **없다**(`grep fuzzy`는 edit-ladder/sensitivity-classifier만). 새 스코어러를 만들기보다 prefix→substring 2-tier(검증 가능, n=1 정당화 불필요)로 시작하고, 더 정교한 랭킹은 측정 후 별도 ADR(§8).

### 4.6 accept 라운드트립 — 백엔드 무변경

accept 시 `buf`의 `[atTriggerPos, cursor)` 구간을 `candidate.insertText`로 교체하고 드롭다운을 닫는다. **삽입되는 것은 raw `@target` 텍스트**(예: `@src/util.ts`). 그러면:

1. 제출 시 `readLine`이 `buf`를 그대로 resolve(기존 `settleResolve` `:363-369`).
2. `prompt-pipeline`이 그 텍스트를 turn으로 흘림(무변경).
3. agent 루프가 `latestUserTextFromWm`(`loop.ts:1046`)으로 텍스트를 읽어 `mentionInjector`(`loop.ts:1036`)에 넘김.
4. `mentionInjector` 내부 `parseMentions`(`install.ts:146`)가 `@src/util.ts`를 file 멘션으로 재파싱 → resolve → 주입.

즉 자동완성은 **"올바른 `@target`을 사용자가 빠르게 입력하도록 돕는 것"**일 뿐, 백엔드 파싱/주입 경로는 1바이트도 안 바뀐다. 이것이 "활성화"의 본질.

### 4.7 `@path:line` 라인 참조 확장 (parser, Claude 흡수)

Claude `parseAtMentionedFileLines`(`_cli-symbols.txt:112250`) 흡수: file 멘션에 `:line` 또는 `:start-end` suffix 허용. 현재 `FILE_PATH_RE = /^[A-Za-z0-9_./~][A-Za-z0-9_./~-]*$/`(`parser.ts:97`)는 `:`를 알파벳에 포함하지 않음.

확장안(파서 변경 최소화):
- file alphabet에 `:`를 **포함하지 않고**, `narrowFilePayload`(`parser.ts:112-123`)에서 `path:line` 형태를 인지해 `target = "src/foo.ts"` + 별도 `line?: {start, end}` 필드로 분리. `ParsedMention`에 `readonly line?: {start:number; end?:number}` 옵션 추가(미사용 시 기존 소비자 byte-identical — `types.ts:59` 확장).
- 라운드트립: 자동완성이 `@src/foo.ts:42`를 삽입 → parser가 `target=src/foo.ts`, `line={start:42}` → file resolver가 해당 라인 window만 발췌(향후; 1차는 `line` 필드만 보존, resolver는 전체 파일 — `file-resolver.ts`의 truncation과 직교).

> **이 확장은 별도 ADR 필요**(parser는 ADR-0418로 locked, `parser.ts:42`/`types.ts:47-48`). 1차 RFC 범위에서는 옵션 필드 추가 + 후방호환만, line-window 발췌는 §8.

### 4.8 Default-OFF

`readLine`에 **신규 옵션** `atProvider?: AtCandidateProvider`를 추가(`ReadLineOptions` `:48-72`). `atProvider === undefined`면 §4.3 상태 머신 진입 자체가 죽어(`@`는 일반 문자로 `:676-690` 일반 입력 분기) — **모든 키 경로가 오늘과 byte-identical**. `prompt-pipeline.ts:82-89`의 `readLine` 호출이 이 옵션을 조건부 spread(`...(atProvider ? {atProvider} : {})`)하므로 미주입 시 객체 형태도 동일.

---

## 5. 통합 (wire) — 정확한 편집 지점

### 5.1 raw-line-reader 훅 (`src/apps/cli/raw-line-reader.ts`)

- `ReadLineOptions`에 `atProvider?: AtCandidateProvider` 추가 (`:48-72`).
- `State`에 `at*` 필드 5개 추가 (`:141-166`, default 비활성).
- `onKey`(`:472`)에서 **슬래시/search/heredoc 분기 이후, 일반 문자 입력 이전**에 `@`-모드 분기 삽입:
  - 일반 문자 입력(`:676-690`) 안에서 `str === "@"` AND `atProvider !== undefined` AND 좌-boundary OK ⇒ `atActive=true`, `atTriggerPos=cursor`, `provider.list("")` 비동기 시작.
  - `atActive`일 때 ↑↓/Tab/Enter/Esc/Backspace를 §4.3 머신으로 라우팅(슬래시 리스트 키 처리 `:577-617`와 **독립 분기**, `state.listOpen`과 충돌 안 하도록 `atActive` 우선 체크).
  - accept는 신규 `commitAtSelected()`(기존 `commitSelected()` `:399-407` 패턴 미러; 단 전체 buf 교체가 아니라 `[atTriggerPos,cursor)` slice 교체).
- `targetReserved()`(`:223-231`)/`renderListRows()`(`:247-264`)에 `@`-리스트 분기 추가(kind 헤더 포함).
- 신규 비동기 후보 도착 콜백은 `redraw()`(`:266`) 재호출 + epoch 가드(§6.1).

### 5.2 prompt-pipeline wire (`src/apps/cli/repl/prompt-pipeline.ts`)

```ts
// defaultPromptLineReader (:77-95) — atProvider 조건부 전달
const raw = await readLine({
  prompt: "› ",
  completer: (line) => slashCompleter(line)[0],
  describe: describeSlashCommand,
  ...(signal !== undefined ? { signal } : {}),
  ...(ux?.promptHistory !== undefined ? { history: ux.promptHistory } : {}),
  ...(ux?.multiline === true ? { multiline: true } : {}),
  ...(ux?.atProvider !== undefined ? { atProvider: ux.atProvider } : {}),   // 신규
})
```

- `PromptPipelineUxOpts`(`:21-24`)에 `readonly atProvider?: AtCandidateProvider` 추가.
- 미주입 ⇒ spread가 빈 객체 ⇒ `readLine`에 atProvider 없음 ⇒ §4.8로 byte-identical.

> **제출 시 `parseMentions`를 prompt-pipeline에 또 붙일 필요는 없다** — §2.1에서 확인한 대로 agent 루프(`loop.ts:1036`)가 이미 한다. 이 RFC는 *입력 표면*만 닫는다. (사용자 가설의 "wire parseMentions into prompt-pipeline"은 **불필요** — 이미 loop에서 닫혀 있으므로 중복 파싱은 회피. RFC는 이 사실을 정직히 반영.)

### 5.3 feature flag env knob

- `QUANTA_AT_AUTOCOMPLETE=1`일 때만 composition root가 `atProvider`를 구성·주입. 미설정 ⇒ `atProvider=undefined` ⇒ byte-identical.
- env 헬퍼는 기존 idiom(`isolatedMcpEnabledFromEnv` 류) 패턴으로 `src/apps/cli/at-autocomplete/env.ts:atAutocompleteEnabled()`.
- composition root(CLI feature 로딩, `apps/cli/internal.ts` 영역 — MCP wire가 사는 `:635` 인근)에서: `createCompositeAtProvider({cwd, fileRoot, symbolLookup: createLspSymbolLookup(...)})` 구성 후 `ux.atProvider`로 전달.

### 5.4 정확한 file:line 요약

| 편집 | 위치 |
|---|---|
| `ReadLineOptions.atProvider` 추가 | `raw-line-reader.ts:48-72` |
| `State.at*` 5필드 | `raw-line-reader.ts:141-166` |
| `@`-trigger 분기 | `raw-line-reader.ts:676-690`(일반 입력 직전) |
| `@`-키 라우팅(↑↓/Tab/Enter/Esc/BS) | `raw-line-reader.ts:577-661` 인근 신규 우선 분기 |
| `commitAtSelected()` | `raw-line-reader.ts:399`(commitSelected 미러) 인근 |
| `targetReserved`/`renderListRows` 분기 | `raw-line-reader.ts:223-264` |
| `PromptPipelineUxOpts.atProvider` | `prompt-pipeline.ts:21-24` |
| `readLine` 조건부 전달 | `prompt-pipeline.ts:82-89` |
| env gate | 신규 `at-autocomplete/env.ts` + `internal.ts:~635` |
| `ParsedMention.line?` (선택, §4.7 별도 ADR) | `types.ts:59-74` + `parser.ts:112-123` |

---

## 6. Edge cases

| 케이스 | 처리 |
|---|---|
| **코드/paste 안의 `@`** | (a) 좌-boundary 체크(§4.3a, `parser.ts:104` 미러) — 식별자 뒤 `@`는 트리거 안 함. (b) **paste 감지**: raw-mode에서 paste는 다중 char가 빠르게 도착(`onKey`가 `str.length>1`로 들어옴, `:676`). `str.length>1`이면 `@`-트리거를 **건너뛴다**(paste는 자동완성 의도 아님). |
| **단어 중간 `@`** | 좌-boundary 위반 ⇒ 일반 문자로 삽입(드롭다운 안 뜸). |
| **후보 0개** | 드롭다운 미표시(`atCandidates.length===0` ⇒ `atActive`는 유지하되 리스트 행 0; band 안 늘림). 타이핑 계속 시 재조회. |
| **거대 디렉토리** | file provider가 `maxPerKind`(default 8) cap + 워크스페이스 walk는 prefix 디렉토리만(전체 재귀 walk 금지) + signal로 중도 취소. "+N more"(`raw-line-reader.ts:262` 패턴) 표시. |
| **멀티바이트(한글/CJK)** | 기존 `stringColumns`/`charColumns`(`:103-129`)로 컬럼 정렬; `atTriggerPos`/cursor는 **코드포인트가 아니라 char 인덱스**(기존 buf 슬라이싱과 동일 `:651` `slice`)로 일관 — 기존 백스페이스/커서 로직과 같은 단위. |
| **드롭다운 vs 터미널 높이** | `growBandTo`(`:233`) scroll-stability 재사용; band는 monotonic grow, kind 헤더 포함 행 수가 화면 높이 초과 시 `MAX_VISIBLE_CANDIDATES`로 cap + more 표시. |
| **async resolve 도중 abort/취소** | (a) `opts.signal` abort ⇒ 기존 `settleReject(AbortError)`(`:379-388`) 경로 — 진행 중 `provider.list` promise는 epoch 가드로 무시. (b) **race**: 빠른 타이핑으로 `list("u")` 후 `list("ut")`가 먼저 도착하면 **stale 결과 폐기** — `atQueryEpoch` 증가 토큰(MCP RFC의 `restartEpoch` 패턴 흡수)으로 최신 쿼리 결과만 반영. (c) provider throw/reject ⇒ 빈 배열로 강등(NO-THROW, §6.1). |
| **provider 미주입(default-OFF)** | §4.8 — `@`는 일반 문자, 모든 키 경로 byte-identical. |
| **`@` 입력 후 즉시 Enter** | `atActive`+선택 후보 있으면 accept하지 않고 **드롭다운만 닫고 제출**할지 vs accept 후 제출할지: 슬래시 패턴(`:524-525`은 listOpen+selected면 commit 후 제출)을 미러 — **선택 후보가 있으면 commit 후 제출**, 없으면 raw `@query` 그대로 제출(parser가 알아서 처리). |

### 6.1 NO-THROW + race-safe 비동기

```ts
// 개념: atQueryEpoch 토큰으로 stale 결과 폐기
const myEpoch = ++state.atQueryEpoch
let cands: readonly AtCandidate[]
try { cands = await atProvider.list(query, signal) }
catch { cands = [] }                       // NO-THROW 강등
if (myEpoch !== state.atQueryEpoch) return // stale(더 최근 쿼리 떴음) ⇒ 폐기
if (settled) return                        // 이미 제출/abort됨
state.atCandidates = cands
state.atSelectedIdx = cands.length > 0 ? 0 : -1
redraw()
```

---

## 7. 테스트 계획 (hellgate — 주입 keypress 스트림 + fake provider, 실제 TTY 0개)

raw-line-reader는 이미 keypress 단위 테스트 가능(`onKey`가 `(str, key)` 시그니처, `:472`). 기존 export된 test seam(`__ghostSuffixForTest` 등 `:713-715`) 패턴으로 `@`-경로를 봉인. fake provider는 동기적으로 미리 채운 후보를 반환(또는 `Promise.resolve`).

신규: `src/apps/cli/at-autocomplete/__tests__/provider.hellgate.test.ts`, `src/apps/cli/__tests__/raw-line-reader-at-mention.hellgate.test.ts`.

1. **`@` 트리거 → 드롭다운**: 좌-boundary OK 위치에서 `@` 입력 ⇒ `atActive=true`, `provider.list("")` 호출, 후보 렌더.
2. **타이핑 → 퍼지 필터**: `@`+`u`+`t` ⇒ `provider.list("ut")` 호출, prefix 매치 우선 정렬(`slash-engine.ts:44` 동치) 검증.
3. **accept 삽입**: 후보 선택 후 Tab/Enter ⇒ `buf[atTriggerPos..cursor)`가 `insertText`로 교체, 드롭다운 닫힘, cursor가 삽입 끝으로.
4. **Esc dismiss**: `buf` 무변경 + `atActive=false` + band 축소.
5. **제출 시 멘션 라운드트립**: accept 후 Enter로 제출한 `buf`를 `parseMentions`(`parser.ts:251`)에 넣어 기대 `ParsedMention`(kind/target/span) 나옴 — 입력→파서 end-to-end 동치.
6. **race(stale 폐기)**: `list("u")`가 느리게, `list("ut")`가 먼저 resolve ⇒ 최신(`"ut"`) 후보만 반영(epoch 가드).
7. **paste 무트리거**: `str.length>1`(`"foo@bar"` paste) ⇒ `@`-트리거 안 됨, 일반 삽입.
8. **좌-boundary**: `foo` 뒤 `@` ⇒ 트리거 안 함; 공백/시작 뒤 `@` ⇒ 트리거.
9. **provider throw/reject ⇒ 빈 후보**: 적대적 provider가 throw ⇒ 드롭다운 빈 채로 graceful, 입력 계속 가능.
10. **멀티바이트 정렬**: 한글 detail 후보의 `stringColumns` 컬럼 정렬 + accept 시 char-index 일관성.
11. **kind-grouped 렌더**: file+symbol 혼합 후보가 헤더 분리되어 렌더.
12. **DEFAULT-OFF byte-identical 회귀**(봉인 anchor): `atProvider` 미주입으로 동일 keypress 스트림(슬래시 팔레트/히스토리/heredoc/멀티바이트/ghost 포함)을 흘려 **stdout 바이트 + 최종 resolve 문자열이 oday와 완전 동일**. `@` 문자도 일반 입력으로 들어감.

provider 단위(separate):
13. **file enumerate cap + jail**: `fileRoot` 밖 경로 미노출(`is-path-inside`, `file-resolver.ts:35` 동치), `maxPerKind` cap.
14. **symbol enumerate graceful**: `symbolLookup` 미주입/anchor 없음 ⇒ `[]`(`symbol-lookup-lsp.ts:18-20` 동치).
15. **skill/plugin/app list 미주입 ⇒ `[]`**: 옵션 list 콜백 absent면 그 kind 후보 0.

---

## 8. 파일별 변경 목록

### 신규
| 파일 | 내용 |
|---|---|
| `src/apps/cli/at-autocomplete/port.ts` | `AtCandidate`, `AtCandidateProvider` (closed port) |
| `src/apps/cli/at-autocomplete/provider.ts` | `createCompositeAtProvider`, `CompositeAtProviderDeps` (kind별 어댑터 합성) |
| `src/apps/cli/at-autocomplete/file-list.ts` | file prefix walk(cwd jail, `is-path-inside` 재사용) |
| `src/apps/cli/at-autocomplete/symbol-list.ts` | `SymbolLookupLspPort`(`symbol-lookup-lsp.ts`) → `AtCandidate` 어댑터 |
| `src/apps/cli/at-autocomplete/fuzzy.ts` | prefix→substring 2-tier 결정적 랭킹(§4.5; 신규 점수식 없음) |
| `src/apps/cli/at-autocomplete/env.ts` | `atAutocompleteEnabled()` env gate |
| `src/apps/cli/at-autocomplete/index.ts` | leaf barrel(selective re-export) |
| `src/apps/cli/at-autocomplete/__tests__/provider.hellgate.test.ts` | §7 13–15 |
| `src/apps/cli/__tests__/raw-line-reader-at-mention.hellgate.test.ts` | §7 1–12 |
| `docs/decisions/0436-at-mention-autocomplete.md` | ADR |

### 편집
| 파일 | 변경 |
|---|---|
| `src/apps/cli/raw-line-reader.ts` | `ReadLineOptions.atProvider`(`:48-72`), `State.at*`(`:141-166`), `@`-trigger + 키 라우팅 + `commitAtSelected`(`:399-690` 인근), `targetReserved`/`renderListRows` 분기(`:223-264`). 미주입 시 byte-identical. |
| `src/apps/cli/repl/prompt-pipeline.ts` | `PromptPipelineUxOpts.atProvider`(`:21-24`) + `readLine` 조건부 전달(`:82-89`). |
| `src/apps/cli/internal.ts` | `atAutocompleteEnabled()` gate + `createCompositeAtProvider(...)` 구성 → `ux.atProvider` 주입(`:~635` MCP wire 인근). |
| (선택, 별도 ADR) `src/agent/mention-injection/types.ts` + `parser.ts` | `ParsedMention.line?`(`:59-74`) + `narrowFilePayload` `:line` 인지(`:112-123`). 후방호환. |

### slice fence
- `@/apps/cli/at-autocomplete`는 `@/agent/mention-injection`(타입: `MentionKind`) + `@/agent/plugin-app-resolver`(파일 root 정책) + `@/tool`(`SymbolLookupLspPort`는 `mention-injection`에서 re-export) + `@/shared`만 import. `@/llm`/agent loop import 금지.
- `raw-line-reader`는 `at-autocomplete` 포트만 알고 구체 어댑터는 모름(DIP) — 슬래시 `completer`가 `slashCompleter` 함수만 받는 것과 동일 패턴(`prompt-pipeline.ts:84`).
- mention 백엔드(`mention-injection`, `plugin-app-resolver`) **mutate 금지** — 자동완성은 *나열만* 추가, resolve/inject 경로 불변(§4.6).

---

## 9. 대략 공수
- `port.ts` + `fuzzy.ts` + 테스트: 0.5d (순수, idiom 재사용).
- `file-list.ts` + `symbol-list.ts` + `provider.ts` + provider hellgate: 1d (fs walk jail + LSP 어댑터).
- `raw-line-reader.ts` `@`-머신 + 렌더 + race/epoch + keypress hellgate: 1.5d (**핵심 위험** — 기존 슬래시/히스토리/heredoc 무회귀가 가장 까다로움; default-OFF byte-identical 봉인 필수).
- prompt-pipeline + internal.ts wire + env gate + 회귀 anchor: 0.5d.
- (선택) parser `:line` 확장 + ADR: 0.5d (별도 ADR).
- **합계 ~3.5d**(별도 ADR 제외 시 ~3d). 1 worktree-isolated agent, hellgate-first TDD, raw-line-reader는 회귀 위험이 커 default-OFF 회귀 anchor를 **가장 먼저** 작성.

---

## 10. SOTA++ 체크리스트
- [x] closed-port (`AtCandidateProvider` 주입, 구체 어댑터는 composition root에서만)
- [x] no globals — provider/cwd/fileRoot/symbolLookup 전부 주입, env gate는 wire에서만
- [x] default-OFF byte-identical (§4.8 `@`=일반문자, §5.2 조건부 spread, §7-12 회귀 anchor)
- [x] 기존 백엔드 **무변경 재사용** (§4.6 라운드트립 — `parseMentions`/`mentionInjector`/inject 경로 1바이트 불변; §2.1에서 loop 소비 이미 닫힘 확인)
- [x] 경쟁사 정확 흡수 (Codex `at-mention-list`/kind-group, Claude `@file`/`parseAtMentionedFileLines` 라인참조) — DOM 오버레이/chip은 명시 제외
- [x] 신규 휴리스틱 금지 — prefix→substring 2-tier 결정적 랭킹, 기존 `slash-engine`/idiom 재사용(`no-heuristics-only-validated` 준수)
- [x] race-safe 비동기 (atQueryEpoch stale-guard, MCP RFC `restartEpoch` 패턴 흡수)
- [x] NO-THROW (provider throw/reject ⇒ 빈 후보 강등)
- [x] 기존 UX 무회귀 봉인 (슬래시 팔레트/히스토리/reverse-i-search/heredoc/ghost/멀티바이트 width)
- [x] slice-fenced `@/...` import, mention 백엔드 mutate 금지
- [x] 정직성 — 사용자 가설 중 "loop에 parseMentions wire 필요"는 **이미 닫힘**(loop.ts:1036), skill/plugin/app은 registry `list()` 부재로 옵션 주입(graceful empty)임을 RFC에 명기
```
