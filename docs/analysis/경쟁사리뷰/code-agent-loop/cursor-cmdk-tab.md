# Cursor 3.2.16 — Cmd-K + Tab Autocomplete (Cpp) 완전 분해

> 향후 기능 개발용 구현 청사진. wire schema + IDE 측 wiring 코드 + 알고리즘 임계값 + UX 흐름 전부 evidence-based. ✅verbatim / ≈inferred / 🔒server-only / ❓unverifiable.

## ★ ML vs Rule-based 분리 (가장 중요)

| 컴포넌트 | ML? | 무엇 |
|---|---|---|
| **`FastApplyModelType` 25개 모델** | ✅ **ML** | patch 합성 모델 (composer-2 / gpt-5.4 / codestral-V4-V7 / sonnet_35_diff/rewrite/...) |
| **`isFusedCursorPredictionModel`** fused 모델 | ✅ **ML** | 다음 편집 위치 + ghost text 동시 stream |
| 서버측 reranking / embeddings | ✅ **ML** | codebase_search 등 (Tab은 미사용) |
| **9개 heuristic** (REVERTING_USER_CHANGE 등) | ❌ **규칙엔진** | provider command 호출 + 결정론적 if/else |
| **`isValidCursorPredictionCase`** | ❌ **규칙엔진** | "Bad Case N" 결정론적 체크 |
| **`hasRejectedTooManySuggestions`** (20 임계) | ❌ **규칙엔진** | 정수 비교 (`counter > 20`) |
| **`isUserReadingCode`** (60s idle) | ❌ **규칙엔진** | 시간 비교 (`now - lastEdit >= 6e4`) |
| **`snoozeCpp`** (5min) | ❌ **규칙엔진** | `setTimeout(..., 300_000)` |
| **chained followup** | ❌ **규칙엔진** | accept event → 다음 stream 트리거 |
| **ControlToken** (COMPLETE/QUIET/LOUD/OP) | ❌ **규칙엔진** | enum + 새 요청 시작 |

★ **분리가 영리한 설계**: *모델은 헛소리 가능*하지만 *규칙엔진이 9 heuristic으로 거른다*. 임계값(20/60s/5min)이 텔레메트리 데이터로 튜닝됐을 수 있지만 *적용*은 모두 결정론적.

→ **quanta 흡수 청사진(§17)은 전부 hand-coded 패턴** — ML 인프라 0으로 구현 가능. 모델 학습 데이터 0. if/else로 그대로.

## 0. 증거 + scope

- `IDE` = `/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js` (50 MB minified, **본체 전부 여기**)
- `extensions/cpp/` = MS C/C++ 언어 확장(syntax) — **함정**, Tab과 무관
- Tab autocomplete = "Cpp" naming (= Cursor PreedictionPlus 추정, surface=ghost text)
- Cmd-K = inline edit slash command surface

## 1. 아키텍처 한눈

```
┌─────────────────────────────────────────────────────────────────┐
│ Editor (Monaco)                                                  │
│   ▲ keystroke / cursor-move / lint-update / param-hint           │
│   │                                                              │
│   ▼  fireCppSuggestionDebounced(editor, uL.<source>)             │
│ ┌─────────────────────────────────────────────┐                  │
│ │ Tab Main Class (14-arg constructor)         │                  │
│ │   - cppEventLogger                           │                  │
│ │   - _cursorPredictionService                 │                  │
│ │   - _cursorPredictionBadHeuristics  ◄─┐      │                  │
│ │   - editorListeners                  │      │                  │
│ │   - snoozeCppTimeout                 │      │                  │
│ │   - lastEditTime / lastLine          │      │                  │
│ │   - numberOfClearedSuggestionsSinceLastAccept │                  │
│ └────────────────┬────────────────────┘      │                  │
│                  │                            │                  │
│  ┌───gate skip───┤                            │ 9 heuristic      │
│  │  hasRejectedTooMany() (>20)                │ filter           │
│  │  isUserReadingCode() (>60s idle)           │                  │
│  ▼                                            │                  │
│  StreamCppRequest 29 fields  ──gRPC-Web──►  api3.cursor.sh        │
│                                              "Cursor Tab"        │
│                                              ↓ (regional: api4)   │
│                              ◄── StreamCppResponse 17 fields ─    │
│                                  + cursor_prediction_target ★    │
│                                  + 9 dedup_heuristic_reason      │
│ ┌──────────────────────────────────────────────┘                  │
│ │ ghostText render (Monaco InlineCompletion)                      │
│ │   _cppGhostTextContainer / cursorGhostTextWidget                │
│ │   _stablizedGhostTexts / _useMultiLineGhostText                 │
│ └──────────┬───────────────────────────────────┘                  │
│            ▼  Tab/Esc/Ctrl+→                                      │
│       Accept / Reject                                             │
│            │                                                      │
│            ▼  RecordCppFate(ACCEPT|PARTIAL_ACCEPT|REJECT)         │
│            │  (+ markCppForEval if "Report Good/Bad")             │
│            ▼                                                      │
│       generateChunkedStreamingFollowupSuggestion ★                │
│       (accept 후 즉시 다음 ghost stream → "Tab Tab Tab" chain)    │
└─────────────────────────────────────────────────────────────────┘
```

**핵심 1**: **별도 extension 아님**. IDE 번들 내장 단일 클래스가 전부 — keystroke 잡고, gate 통과시키고, gRPC 호출하고, ghost 렌더하고, telemetry까지.
**핵심 2**: VS Code 표준 `InlineCompletionsProvider` API에 hook(✅ `provideInlineCompletions` 5건 in IDE). Cursor는 그 표준의 *서버측 모델 + 9 heuristic*만 추가.

## 2. Service surface — wire facing

### 2.1 `aiserver.v1.CppService` (5 메서드) ✅
| 메서드 | Kind | 역할 |
|---|---|---|
| `StreamCpp` (or `StreamCpp*`) | ServerStream | 메인 ghost text stream. `StreamCppRequest` 29필드 → `StreamCppResponse` 17필드 stream |
| `StreamHoldCpp` | ServerStream | "hold" 변종 (long-running prediction maintain ≈) |
| `RecordCppFate` | Unary | accept/reject 결과 보고 — telemetry sink |
| `MarkCppForEval` | Unary | 사용자 "Report Good/Bad" 명시 신호 → eval ingest |
| `AddTabRequestToEval` | Unary | 자동/수동 eval pool 적재 |

Endpoint: `cursorCreds.cppBackendUrl` (기본 `g2n` 상수 = `https://api3.cursor.sh` "Cursor Tab"). 지역별 `api4.cursor.sh`.

### 2.2 `aiserver.v1.CursorPredictionService` (1 메서드) ✅
| 메서드 | Kind | 역할 |
|---|---|---|
| `CursorPredictionConfig` | Unary | 클라 동작 dictate (`Heuristic` 2값) — fused 모델 on/off 등 |

### 2.3 `aiserver.v1.ChatService` Cmd-K 슬롯 ✅
- `StreamFullFileCmdK` (ServerStream) — Cmd-K로 전체 파일 재작성
- `WarmFullFileCmdK` (Unary) — prefetch

### 2.4 `aiserver.v1.AiService` Cmd-K 패밀리 ✅
`SlashEdit` / `SlashEditFollowUpWithPreviousEdits` / `StreamEdit` / `PreloadEdit` / `StreamFastEdit` / `ReportCmdKFate` — 6개

**총 12 Cmd-K + 6 Tab RPC = 18.**

## 3. Trigger 파이프라인 ✅

`fireCppSuggestionDebounced(editor, source: uL)` — 모든 진입점이 통과. **`uL` enum = 10값 전수 verbatim** ✅:

```js
// (function(n){
n.Unknown          = "unknown"
n.LineChange       = "line_change"          // 줄 이동 (cursor가 다른 줄로)
n.Typing           = "typing"               // 타이핑 활성 (fireCppSuggestionDebouncedDiffHistory 분기)
n.OptionHold       = "option_hold"          // ★ Alt/Option 키 누름 (manual peek)
n.LinterErrors     = "lint_errors"          // lint 마커 갱신 (코드 깨졌으니 fix 제안)
n.ParameterHints   = "parameter_hints"      // IntelliSense 패널 닫힘 직후 auto re-trigger
n.CursorPrediction = "cursor_prediction"    // ★ fused 모델이 *다음 위치* 예측 → 거기서 chain trigger
n.ManualTrigger    = "manual_trigger"       // 사용자 명시 단축키
n.EditorChange     = "editor_change"        // keystroke (가장 일반)
n.LspSuggestions   = "lsp_suggestions"      // LSP 자동완성 후보 갱신
// })(uL||(uL={}))
```

**★ 기깔남 3가지**:
1. **`LinterErrors`** — lint error 만드는 순간 fix 제안 stream. quanta verify-guard와 같은 발상(상태변화→에이전트 액션).
2. **`OptionHold`** — Alt/Option 키 누름이 별도 trigger. "잠깐 ghost 보여줘" peek UX.
3. **`CursorPrediction`** — fused 모델이 다음 편집 위치 예측 → 그 위치서 다음 ghost가 chain trigger. **`generateChunkedStreamingFollowupSuggestion`(§9)과 짝**: accept 후 cursor 점프 → Tab → 점프 → Tab 의 무한 chain.

**별도 함수**: `fireCppSuggestionDebouncedDiffHistory(editor, isTyping, source, r)` — diff history 모드 (최근 편집 패턴 학습).

## 4. Suppression heuristics (client-side gate) ✅ verbatim

`fireCppSuggestionDebounced` 호출 직전 2개 게이트 통과 필수:

### 4.1 `hasRejectedTooManySuggestions()` — reject 누적 한계
```js
hasRejectedTooManySuggestions() {
  return this.numberOfClearedSuggestionsSinceLastAccept
       > (this.persistentStorage().cppConfig?.maxNumberOfClearedSuggestionsSinceLastAccept ?? 20)
}
```
- **임계 20** (client default, **server `cppConfig`로 override**).
- accept 없이 20번 reject/clear → 자동 정지 → "사용자가 싫어하는 모드면 멈춰".
- 이게 cursor-cmdk-tab 초안 "20-request client buffer"의 정체 — **reject counter** (정정).

**카운터 갱신 path (✅ 모두 verbatim 확인)**:
- `numberOfClearedSuggestionsSinceLastAccept += 1` — clear/reject 시 증가
- `= 0` 리셋 3 경로:
  1. **constructor 초기화**: `this.numberOfClearedSuggestionsSinceLastAccept = 0`
  2. **`clearAndResetAllCppSuggestions({removeGreens, abortAll, skipMultidiff})`**: 모든 ghost 강제 clear (snooze 시작 / 큰 컨텍스트 변경)
  3. **`clearSuggestions(cppConfig?.i...)` after accept**: requestId/modelVersion/modelId 등 record 후 카운터 리셋. **= accept이 카운터 리셋의 정상 path** ✅

### 4.2 `isUserReadingCode()` — 60s idle threshold
```js
isUserReadingCode() {
  return this.lastEditTime === void 0
      || Date.now() - this.lastEditTime >= 6e4   // 60,000 ms = 60s
}
```
- **60초 무편집 → reading mode 가정, Tab 일시정지**.
- 사용자가 코드 *읽는* 중이면 ghost text로 방해 안 함.
- ★ 단순하지만 효과적. quanta CLI/Tauri의 idle suppress 후보.

**`lastEditTime` 갱신 path** ✅:
- `this.lastEditTime = Date.now()` — 매 keystroke / model change event
- `this.lastEditTime = void 0` — 명시 리셋 (snooze 시작 / model dispose 등)
- 비교: `this.lastEditTime === void 0 || Date.now() - this.lastEditTime >= 6e4`
  - `void 0`이면 즉시 reading mode (안전한 default — 무편집 = 읽기)
  - 60초 경과면 reading mode

## 5. Snooze 메커니즘 ✅ — 사용자가 직접 끔

```js
snoozeCpp(e, t) {
  this.snoozeCppTimeout && (clearTimeout(this.snoozeCppTimeout), this.snoozeCppTimeout = void 0)
  this._reactiveStorageService.persistStorage("cppEnabled", false)
  const r = t ?? e
  this.snoozeCppTimeout = setTimeout(() => { this.unsnoozeCpp() }, r)
}
```
- **기본 5분 (300_000 ms)** — `?? 300*1e3`
- **persistent** (재시작 후도 유지, `_reactiveStorageService.persistStorage("cppEnabled", false)`)
- `unsnoozeCpp()` / `maybeReenableCppIfSnoozed()` 자동 복귀
- 명령 팔레트에서 사용자가 5/10/60분 등 선택 가능
- ★ "방해 마"의 정석. quanta는 agent surface가 없지만 *background processing pause* 패턴으로 차용.

## 6. ★ Heuristic enum **2개 분리** + provider-backed 적용 ✅ verbatim

> ⚠️ 이전 "9개 enum 1개" 클레임 정정. 실제는 **2개 enum + provider command 패턴**.

### 6.1 `FBt` enum (cursor-prediction validity, 7값 0~6) ✅
```
FBt[0] HEURISTIC_UNSPECIFIED
FBt[1] HEURISTIC_DISABLE_IN_LAST_CPP_SUGGESTION
FBt[2] HEURISTIC_DUPLICATING_LINE_AFTER_SUGGESTION
FBt[3] HEURISTIC_DUPLICATING_MULTIPLE_LINES_AFTER_SUGGESTION
FBt[4] HEURISTIC_REVERTING_USER_CHANGE
FBt[5] HEURISTIC_OUTPUT_EXTENDS_BEYOND_RANGE_AND_IS_REPEATED
FBt[6] HEURISTIC_SUGGESTING_RECENTLY_REJECTED_EDIT
```
출처: `(function(n){n.UNSPECIFIED=0,n.DISABLE_IN_LAST_CPP_SUGGESTION=1,...,n.SUGGESTING_RECENTLY_REJECTED_EDIT=6})(FBt||(FBt={}))`. (별칭 `O9c`도 동일 IIFE.)

### 6.2 추가 enum(들) (cpp-suggestion dedup): `Blt`/`Brt`/`Byt`/`EBt` 중 하나 ✅
3개 추가 heuristic이 별도 enum에 살아있음 (이름이 FBt랑 안 겹침):
```
{no:1, name:"HEURISTIC_LINT_OVERLAP"}        // 제안이 기존 lint error 영역 침범
{no:1, name:"HEURISTIC_LOTS_OF_ADDED_TEXT"}  // 너무 큰 변경
{no:2, name:"HEURISTIC_LINES_MISMATCH"}      // 제안 라인과 실제 컨텍스트 불일치
```
즉 **총 9 unique HEURISTIC_ 이름** (그 중 6 in FBt, 3 in 다른 enum). 이전 "단일 9-value enum" 클레임은 잘못.

### 6.3 ★ 적용 알고리즘 — provider-backed (단순 string 매치 아님)
**가장 중요한 발견**. heuristic 적용은 **결정론적 provider command 호출**:

```js
// cppConfig.heuristics가 Set → 활성 heuristic만 적용
const d = ...applicationUserPersistentStorage.cppConfig?.heuristics
if (d === void 0) return { valid: !0, modelOutputText: t }    // 미설정시 통과

// REVERTING_USER_CHANGE 적용:
if (d.includes(FBt.REVERTING_USER_CHANGE)) {
  const h = yTm(e, i, t, s, r)              // model output 라인 추출
  const f = this._workspaceContextService.asRelativePath(e.uri)
  for (const g of h) {
    if (await this._everythingProviderService.onlyLocalProvider?.runCommand(
        j6e.IsRevertingToRecentModel,         // ★ provider command
        { relativePath: f, modelValue: g }
    )) { /* 거절 */ }
  }
}

// SUGGESTING_RECENTLY_REJECTED_EDIT 적용:
if (d.includes(FBt.SUGGESTING_RECENTLY_REJECTED_EDIT)) {
  const h = yTm(e, i, t, s, r)
  const f = this._workspaceContextService.asRelativePath(e.uri)
  const g = cppConfig?.recentlyRejectedEditThresholds   // ★ 서버 푸시 임계
  if (g !== void 0) {
    for (const y of h) {
      if (await this._everythingProviderService.onlyLocalProvider?.runCommand(
          j6e.IsSuggestingRecentlyRejectedEdit,
          {
            relativePath: f,
            modelValue: y,
            numberOfTimesSoftRejectedThreshold: g.softRejectThreshold   // 추정 필드명
          }
      )) { /* 거절 */ }
    }
  }
}
```

### 6.4 핵심 발견 (구현 시 중요)
- **`j6e` enum 10 commands verbatim 전수** ✅ — local provider interface 풀세트:
  ```
  j6e.Ack                                    // acknowledgement
  j6e.CompileGlobalDiffTrajectories          // ★ diff history 컴파일 (글로벌 trajectory)
  j6e.FormatDiffHistory                      // diff 포맷팅
  j6e.GetModelValue                          // 현재 model 텍스트 조회
  j6e.InitModel                              // model 초기화
  j6e.IsRevertingToRecentModel               // 사용자 의도 거역 체크 (FBt[4])
  j6e.IsSuggestingRecentlyRejectedEdit       // recent reject 체크 (FBt[6])
  j6e.RecordRejectedEdit                     // ★ reject 기록 저장
  j6e.SetEnableCppIncludeUnchangedLines      // 토글
  j6e.SetEnableCppWhitespaceDiffHistoryMode  // 토글
  ```
- ★ **`RecordRejectedEdit`가 provider에 reject 기록을 *저장*** → 나중에 `IsSuggestingRecentlyRejectedEdit`가 조회. **Provider = persistent rejection history 보유 + diff trajectory 추적**.
- ★ **`CompileGlobalDiffTrajectories`** — 단일 파일이 아니라 *글로벌* diff history (워크스페이스 단위). 모델이 cross-file 패턴 학습 가능.
- **각 model output 라인마다 per-line check** — 전체 ghost를 한 번에 평가 아니라 줄별.
- **`cppConfig.heuristics`는 Set** — 서버가 활성 heuristic만 push (A/B 실험에 직접 활용).
- **`cppConfig.recentlyRejectedEditThresholds.softRejectThreshold`** — 라인이 몇 번 soft-reject되면 차단할지 (★ "soft reject" 개념 = ghost 본 후 dismiss했지만 명시 거절 클릭 안 한 경우).
- **`yTm(e, i, t, s, r)`** = model output line extractor. internal helper.
- **`everythingProviderService.onlyLocalProvider`** = local-only provider (서버 호출 X, 클라 메모리/스토리지에 edit history 보관). **diff trajectory + rejection history 둘 다 로컬**.

### 6.5 `isValidCursorPredictionCase` (별도 — fused cursor-prediction 적용시) ✅
```js
isValidCursorPredictionCase(n) {
  return n.cppSuggestionRange !== void 0
       && n.predictedLineNumber >= n.cppSuggestionRange.startLineNumber
       && n.predictedLineNumber <= n.cppSuggestionRange.endLineNumberInclusive
    ? (console.log("[Cursor Prediction] Bad Case 1: Do not show prediction if it's in the accepted cpp suggestion range"),
       { valid: !1 })
    : ...continues with Bad Case 2/3/...
}
```
- **Bad Case 1 확인**: 다음-편집-예측이 *방금 accept한 ghost와 같은 라인*이면 거절(stuttering 방지).
- Bad Case 2, 3...는 본체 truncated, 추후 확인 필요.

★ **가장 영리한 4개** (REVERTING_USER_CHANGE / SUGGESTING_RECENTLY_REJECTED_EDIT / Bad Case 1 / LINT_OVERLAP): "사용자 의도 거역 + 자기 자신 반복" 패턴 명시적 차단. quanta reflect-gate(ADR-0098)에 provider-backed 패턴 차용 가능.

## 7. `cppConfig` server-pushed 13+ 필드 ✅ (server controls everything)

클라 설정은 단 **2개** (§14), 나머지 동작은 전부 서버가 매 turn push:

```ts
cppConfig?: {
  isOn: boolean                                          // kill-switch
  shouldLetUserEnableCppEvenIfNotPro: boolean            // free-tier toggle
  maxNumberOfClearedSuggestionsSinceLastAccept: number   // §4.1 임계 (default 20)
  heuristics: Heuristic[]                                // §6의 활성 heuristic Set
  isGhostText: boolean                                   // ghost vs inline
  isFusedCursorPredictionModel: boolean                  // fused 모델 (§13) 활성
  mergeBehavior: MergeBehavior                           // 다중 제안 머지 정책 (enum 값 미식별)
  importPredictionConfig: { pythonEnabled: boolean, ... } // import 자동 제안 (Python 확인됨)
  recentlyRejectedEditThresholds: { softRejectThreshold: number, ... }  // §6 #9 임계
  excludeRecentlyViewedFilesPatterns: string[]           // RVF에서 제외할 glob
  shouldFetchRvfText: boolean                            // RVF 텍스트 fetch 여부
  enableRvfTracking: boolean                             // Related Visible Files 추적
  checkFilesyncHashPercent: number                       // sync 검증 sampling
}
```

★ **`enableRvfTracking` + `excludeRecentlyViewedFilesPatterns`**: 사용자가 *최근 본 파일* 추적 → Tab 컨텍스트에 추가. "내 코드베이스를 아는 것 같다"의 *Tab*-측 정체.

### 7.1 ★ **60s polling reload** ✅
```js
async fastPeriodicallyReloadCppConfig() {
  Date.now() - this.lastReloadConfigTimestamp > 1e3*60        // 60초 임계
    && (
      await this.loadCppConfigIncludingHandlingProAccess(),
      this.debouncer.setDebouncingDurations(this.getNewDebounceDurations()),  // ★ debounce 재설정
      this._importPredictionService.handleNewImportPredictionConfig()
    )
}

async loadCppConfigIncludingHandlingProAccess() {
  this.lastReloadConfigTimestamp = Date.now()
  await this.keepCppModelStateUpdated()
  const t = await (await this.aiClient()).cppConfig(new urc({
    supportsCpt: !0,                          // ★ CPT 지원 클라가 알림
    model: this.persistentStorage().cppModel ?? ""
  }))
  this._applyConfig(t)
  this._cursorCredsService.setGeoCppBackendUrl(t.geoCppBackendUrl)
}
```
- **매 60초마다 서버 `cppConfig` 재조회** → 모든 임계/heuristic/모델 push 갱신.
- `supportsCpt: true` = 클라가 **CPT (Cursor Prediction Tab) 지원함을 알림** → 서버가 그에 맞는 config 푸시.
- `geoCppBackendUrl` 서버 응답에 포함 → 지역별 endpoint 동적 라우팅(api3/api4.cursor.sh 변경 가능).
- `debouncer.setDebouncingDurations(getNewDebounceDurations())` — **debounce ms도 매 reload 시 갱신** (§7.2).

### 7.2 ★ **2-tier debouncer**: client=25ms + total=60ms ✅ **verbatim**
```js
getNewDebounceDurations() {
  const e = this._reactiveStorageService.applicationUserPersistentStorage.cppConfig
  if (e === void 0) return { clientDebounceDuration: j$C, totalDebounceDuration: K$C }
  // ↑ defaults j$C=25, K$C=60  ✅ verbatim 확정
  // ...else cppConfig에서 값 사용
}

setDebouncingDurations({ clientDebounceDuration: n, totalDebounceDuration: e }) {
  // 두 임계로 debounce
}
```

★ **정확한 default ms** ✅:
- `j$C = 25` → **`clientDebounceDuration = 25ms`** (클라-only 디바운스: keystroke 후 25ms 안 새 keystroke 오면 reset)
- `K$C = 60` → **`totalDebounceDuration = 60ms`** (전체: 25ms client + ~35ms network 여유 ≈)
- 둘 다 `cppConfig`로 server push 가능 (60s polling 갱신, §7.1)

★ **놀랍게 짧음**: 보통 IDE autocomplete는 200-500ms 쓰는데 Cursor는 **25ms / 60ms**. 사용자 perceptive latency 극단 최소화. 모델 inference latency를 *streaming* + cache warming(double-issue)으로 가린다.

★ **서버 push 패턴**: 클라 release 안 해도 임계/heuristic/모델/debounce/endpoint 즉시 swap. quanta 흡수: per-session config dynamic override.

## 8. Ghost text 렌더 ✅ (Monaco widget)

90+ ghostText 식별자. 핵심:

| 심볼 | 역할 |
|---|---|
| `_cppGhostTextContainer` | Cpp 전용 컨테이너 (일반 inline completion과 분리) |
| `cursorGhostTextWidget` | Monaco 위에 얹는 widget |
| `_scanForGhostText` / `_scanForGhostTextAdvanced` | 기존 텍스트와 ghost 충돌 스캐닝 |
| `_stablizedGhostTexts` | **안정화** — stream 중 깜빡임 방지 (LCP 같은 안정 prefix 유지) |
| `_useMultiLineGhostText` / `useMultiLineGhostText` | 멀티라인 ghost 활성 토글 |
| `shouldFilterGhostText` | 후처리 필터 |
| `editorThatWeHidGhostTextOn` | 다른 에디터 포커스 시 hide 추적 |
| `computeGhostText` | 후보 → 최종 ghost text 계산 |
| `primaryGhostText` | 첫 번째(주) 제안 |

★ **`cursor_prediction_target`** (`StreamCppResponse` 필드, fused 모델 전용) → 다음 편집 위치도 같이 stream → ghost가 *현재 + 다음 위치* 동시 표시. "Tab Tab" 누르면 다음 위치로 jump.

## 9. Accept / Reject UX ✅

키 바인딩:
```
acceptNextWord                 // 단어 단위 부분수락
acceptNextWordSuggestion       // 별도 변종
inlineSuggest.acceptNextLine   // 줄 단위
handleKeyDownForCppKeys        // 키보드 핸들러 (window-level)
```

★ **Chained followup** (`generateChunkedStreamingFollowupSuggestion`):
```js
generateChunkedStreamingFollowupSuggestion(e, t, i, r, s, o, a) {
  const l = VlS(i, { range: O$C(r.range), text: r.replaceText, ... })
  // accept 후 즉시 다음 ghost stream 시작
}
```
→ accept하면 **즉시 다음 ghost stream 시작** → "Tab Tab Tab" 연쇄 UX의 정체.

Partial accept setting: `cursor.cpp.enablePartialAccepts` (§14).

## 10. ControlToken — 새 요청 시작 신호 (BiDi 아님) ✅

```
StreamCppRequest.ControlToken enum:
  COMPLETE = 0   // 정상 (default)
  QUIET = 1      // ghost 안 보이게 (사용자 거부 직후?)
  LOUD = 2       // force show
  OP = 3         // operation 진행중 (사용자 방금 키 누름, 잠깐 대기)
```
**정정**: `StreamHoldCpp` = ServerStreaming (BiDi 아님). 클라가 stream 중간에 mid-stream으로 send 못 함. **ControlToken은 *다음 요청 시작 시* `StreamCppRequest`에 동봉**:
- 사용자가 ghost reject → 다음 typing이 새 요청 시작 → 그 요청에 `controlToken: QUIET` 동봉 → 서버가 quiet 모드로 다음 ghost 생성
- 즉 mid-stream BiDi feedback이 아니라 **next-request-payload-flag** 패턴

★ quanta streaming-dispatch에 mid-request user 신호 채널 추가 시 reference. BiDi 필요 없음 — 다음 요청 payload에 flag만 동봉.

## 10.1 `CursorPredictionSource` enum 5값 ✅ verbatim (fused 모델 trigger source)
```
{no:0, name:"CURSOR_PREDICTION_SOURCE_UNSPECIFIED"}
{no:1, name:"CURSOR_PREDICTION_SOURCE_ALWAYS_ON"}      // 사용자 setting "항상 켜기"
{no:2, name:"CURSOR_PREDICTION_SOURCE_ACCEPT"}         // 직전 accept 후 next 위치 예측 (chain UX)
{no:3, name:"CURSOR_PREDICTION_SOURCE_UNDO"}           // undo 시 (역방향 trajectory)
{no:4, name:"CURSOR_PREDICTION_SOURCE_EDITOR_CHANGE"}  // 편집 변경 시
```
fused 모델 활성 시 어떤 trigger source인지 동봉. `ACCEPT` source = "Tab Tab Tab" chain의 시그너처.

★ `Heuristic` 2값 클레임은 이 enum과 혼동했던 것 — `CursorPredictionConfigResponse.Heuristic`은 별도이고 추출 못 함(미해소). 위 5값은 **source enum**.

## 11. Telemetry ✅

3-channel:
- **`RecordCppFate(fate, request_id, ...)`** — `CppFate` 4값:
  ```
  CPP_FATE_UNSPECIFIED
  CPP_FATE_ACCEPT
  CPP_FATE_PARTIAL_ACCEPT
  CPP_FATE_REJECT
  ```
  매 ghost lifecycle마다 emit.
- **`markCppForEval`** — 사용자 "Report Good"/"Report Bad" 클릭 (UI verbatim). 명시 신호 → server-side eval set 등록.
  ```js
  // UI handler verbatim:
  case "Report Good": t.reportGenerationFeedback(e, HGe.THUMBS_UP); break
  case "Report Bad":  t.reportGenerationFeedback(e, HGe.THUMBS_DOWN); break
  ```
  `HGe` enum 2값: `THUMBS_UP`/`THUMBS_DOWN`. `reportGenerationFeedback(generationId, thumb)`로 단일 진입점.
- **`AddTabRequestToEval`** — 별도 evaluation pool 적재 (자동/수동).

`cppEventLogger` — 메인 클래스 보유 logger.

## 12. Privacy ✅

```
x-ghost-mode             // header (no-train flag)
x-cursor-client-version  // header
ghost_mode               // request field
```
- `x-ghost-mode: true` → 서버가 학습 데이터로 안 씀.
- `cppBackendUrl` (default `g2n` 상수 = api3.cursor.sh) credential override 가능 (self-host).

## 13. CursorPredictionConfig (1 메서드, fused 모델 제어)

```
CursorPredictionConfigResponse.Heuristic enum (2 server-controlled):
  HEURISTIC_UNSPECIFIED
  HEURISTIC_<something>  // 1개 (정확 enum 후속 grep 필요)
```
`cppConfig?.isFusedCursorPredictionModel` true면 fused 모델 활성 → response에 `cursor_prediction_target` 포함.

## 14. 사용자 settings (단 2개) ✅

```
cursor.cpp.disabledLanguages        // ["python", "rust"] 등 - 언어별 끄기
cursor.cpp.enablePartialAccepts     // 부분수락 토글
```

→ 놀랍게 단순. debounce ms, max suggestions, snooze duration 전부 server `cppConfig` push.

## 15. Implementation map (구현 시 starting points)

| 영역 | 핵심 심볼 | IDE 번들 grep으로 찾기 |
|---|---|---|
| 메인 클래스 | 14-arg constructor with `cppEventLogger`, `_cursorPredictionService`, `_cursorPredictionBadHeuristics` | `grep -oE 'constructor\(e,t,i,r,s,o,a,l,u,d,h,f,g,y\)[^{]*\{[^}]{0,500}cppEventLogger' workbench.desktop.main.js` |
| Trigger 분기 | `fireCppSuggestionDebounced`, `fireCppSuggestionDebouncedDiffHistory` | `grep -oE 'fireCppSuggestion[A-Za-z]*\([^)]+\)' workbench.desktop.main.js \| sort -u` |
| Heuristic gate | `_cursorPredictionBadHeuristics.isValidCursorPredictionCase` | `grep -oE '.{60}isValidCursorPredictionCase.{80}'` |
| Ghost text 렌더 | `_cppGhostTextContainer`, `cursorGhostTextWidget`, `_stablizedGhostTexts` | `grep -oE '[a-zA-Z_$]+(GhostText\|cppGhost)[a-zA-Z_$]*' \| sort -u` |
| Chained followup | `generateChunkedStreamingFollowupSuggestion` | grep + 본문 |
| Snooze | `snoozeCpp` / `unsnoozeCpp` / `maybeReenableCppIfSnoozed` / `snoozeCppTimeout` | grep |
| Suppression gates | `hasRejectedTooManySuggestions` / `isUserReadingCode` | grep + 함수 본문 |
| Telemetry | `cppEventLogger`, `RecordCppFate`, `markCppForEval` | grep |

## 16. 정정 (이전 audit/딥다이브)

| 이전 클레임 | 정정 |
|---|---|
| 7 server heuristics | ⚠️ **단일 enum 아님**: `FBt` 7값(cursor-prediction validity) + 다른 enum 3값(cpp-suggestion dedup, LINT_OVERLAP/LOTS_OF_ADDED_TEXT/LINES_MISMATCH) = **2개 enum 총 9 unique 이름** |
| 9 single heuristic enum | ⚠️ 잘못. FBt 7 + 추가 enum 3 분리. 적용 알고리즘은 **`everythingProviderService.onlyLocalProvider.runCommand(j6e.IsXxx, args)` provider-backed** (string 매치 아님) |
| 20-request client buffer | **reject counter** (`numberOfClearedSuggestionsSinceLastAccept > 20`). 별도 buffer 아님. **accept 시 0 리셋** 확인 |
| 10 trigger reasons (CppSource) | ✅ **10값 verbatim 확정**: Unknown/LineChange/Typing/OptionHold/LinterErrors/ParameterHints/CursorPrediction/ManualTrigger/EditorChange/LspSuggestions |
| `extensions/cursor-cpp/` 별도 ext | **함정. `extensions/cpp/` = MS C++ 언어 확장**, Tab은 IDE 번들 내장 |
| Heuristic 단순 if/else | **provider-backed**: `everythingProviderService.onlyLocalProvider.runCommand` async 호출, 사용자 edit history 보유 |
| StreamHoldCpp BiDi (이전 추측) | **ServerStreaming** (`kind:On.ServerStreaming`). ControlToken은 새 요청 시작으로 전달 |
| 휴리스틱 = ML 클래시파이어 | ❌ **규칙엔진**: enum + Set membership + provider command boolean. **모델은 ML(fast-apply), gate는 규칙** |

## 17. quanta 흡수 청사진 (agent-only인 우리에 적용)

quanta에 Tab UX는 **없고 안 만들 것** (agent-only 의도적). 하지만 *메커니즘*은 직접 차용 가능. **모두 hand-coded 규칙엔진, ML 인프라 0**.

### 17.1 Top tier — 즉시 흡수 가능 (구현 5줄~50줄, ML 인프라 0)

| Cursor 메커니즘 | quanta 적용 | 대상 파일 | LOC 추정 |
|---|---|---|---|
| ★ **provider-backed heuristic pattern** (`everythingProviderService.onlyLocalProvider.runCommand(j6e.IsXxx, args)` async boolean) | reflect-gate(ADR-0098) `retry` 분기에 `IsRevertingToRecentEdit`/`IsSuggestingRecentlyRejected` provider check. quanta는 git diff history + 모델 output 줄단위 비교 — local-only OK | `src/agent/reflect-gate.ts` (메서드 추가) + 신규 `src/agent/edit-history-provider.ts` | ~80 |
| ★ **REVERTING_USER_CHANGE** + **SUGGESTING_RECENTLY_REJECTED_EDIT** | 위 reflect-gate 확장 — soft-reject 횟수 임계 (`cppConfig.recentlyRejectedEditThresholds.softRejectThreshold`) 차용 | `src/agent/reflect-gate.ts` | ~50 |
| ★ **`isUserReadingCode` 60s idle** (`now - lastEdit >= 6e4`) | CLI/Tauri idle 시 background processing 일시정지. 키입력 즉시 reactivate | 신규 `src/agent/idle-monitor.ts` | ~30 |
| ★ **`hasRejectedTooManySuggestions` 20-counter auto-stop** | quanta loop에서 사용자 deny 20번 연속 → 자동 종료 + 인계 | `src/agent/loop.ts` + state | ~20 |
| ★ **Snooze 5min persistent** (`setTimeout(unsnooze, 300_000)` + persistStorage) | background tasks 일시정지 명령 | 신규 `src/agent/snooze.ts` | ~40 |
| ★ **Report Good/Bad → eval ingest** | apps/eval EvalRecord additive: `userFeedback?: "good"\|"bad"` 필드 (ADR-0087 매핑) | `src/apps/eval/storage/schema.ts` | ~10 |

### 17.2 Medium tier — 패턴 차용, 구현 더 크다

| Cursor 메커니즘 | quanta 적용 | 대상 파일 | LOC |
|---|---|---|---|
| ★ **Server-pushed `cppConfig` 패턴** | quanta는 BYO-key, 서버 없음. 단 **per-session AgentConfig dynamic override** + admin policy push (조직 deployment 시) | `src/agent/types.ts` + per-session mutator | ~100 |
| ★ **Chained followup** (`generateChunkedStreamingFollowupSuggestion`) | EffectChannel(0093) 위 chain-runner. accept 후 즉시 다음 candidate stream | `src/agent/effect-channel.ts` extension or 신규 `src/agent/chain-runner.ts` | ~150 |
| ★ **ControlToken** (COMPLETE/QUIET/LOUD/OP) mid-stream | steering.ts BiDi 확장. 사용자가 stream 중 quiet/loud 신호 | `src/agent/steering.ts` + `src/agent/streaming-dispatch.ts` | ~80 |
| ★ **`enableRvfTracking` (Recently Viewed Files)** | 컨텍스트에 최근 본 파일 자동 포함 (LRU + glob exclude) | `src/agent/prompt.ts` ContextProvider(0096) 확장 | ~60 |
| ★ **9 trigger sources (uL enum)** | quanta trigger 분기 — keystroke/edit/lint-error/idle 등으로 multi-source 진입 | 신규 `src/agent/trigger-source.ts` | ~50 |

### 17.3 ⛔ 흡수 안 함 (surface-bound or ML 인프라 필요)
- **Monaco ghost text widget** / InlineCompletionsProvider hook — Cmd-K + Tab 자체
- **`_cppGhostTextContainer`** widget DOM
- **`acceptNextWord` 키바인딩**
- **`cursor_prediction_target` fused 모델** (ML model 필요, UI 종속)
- **`FastApplyModelType` 25개 모델** (각각 별도 ML 모델 학습)

### 17.4 ★ 핵심 architectural pattern: "Provider-backed Heuristic" (10 commands interface)

가장 흡수할 가치 있는 *구조* — Cursor `j6e` provider 그대로:

```ts
// quanta version — 10 commands mirror Cursor `j6e`
export interface EditHistoryProvider {
  // 초기화 / 상태 동기화
  ack(): Promise<void>
  initModel(modelId: string): Promise<void>
  getModelValue(modelId: string): Promise<string>

  // diff history (글로벌 trajectory)
  compileGlobalDiffTrajectories(): Promise<DiffTrajectory[]>
  formatDiffHistory(input: { trajectories: DiffTrajectory[] }): Promise<string>

  // rejection 체크 (heuristic 적용 시 호출)
  isRevertingToRecentEdit(input: { relativePath: string; modelValue: string }): Promise<boolean>
  isSuggestingRecentlyRejectedEdit(input: {
    relativePath: string
    modelValue: string
    softRejectThreshold: number    // cppConfig.recentlyRejectedEditThresholds.softRejectThreshold
  }): Promise<boolean>

  // rejection 기록 (사용자가 ghost reject 시 호출)
  recordRejectedEdit(input: {
    relativePath: string
    modelValue: string
    rejectType: "soft" | "hard"    // soft=dismiss, hard=명시 reject
  }): Promise<void>

  // 토글 (서버 push)
  setEnableIncludeUnchangedLines(enabled: boolean): Promise<void>
  setEnableWhitespaceDiffHistoryMode(enabled: boolean): Promise<void>
}

// reflect-gate (0098) 확장:
const provider = config.editHistoryProvider   // default-OFF, 옵션
if (provider) {
  // accept이면 카운터 리셋, 아니면 모델 출력 줄별 cross-check
  const modelLines = extractLines(modelOutput)
  for (const line of modelLines) {
    if (await provider.isRevertingToRecentEdit({ relativePath, modelValue: line }))
      return { kind: "retry", reason: "reverting user change" }
    if (await provider.isSuggestingRecentlyRejectedEdit({
      relativePath,
      modelValue: line,
      softRejectThreshold: config.softRejectThreshold ?? 3,
    }))
      return { kind: "retry", reason: "recently rejected edit" }
  }
}

// 사용자 reject 시 (loop에서 호출):
await provider.recordRejectedEdit({ relativePath, modelValue: rejectedOutput, rejectType: "hard" })
```

→ **핵심 통찰**:
1. **Provider는 *persistent rejection history* 보유** (local-only 가능, server 불필요).
2. **모델 출력 = 줄단위로 분해 → 라인별 cross-check** (덩어리 매치 아님).
3. **Soft vs Hard reject 분리** — soft (dismiss/silent) 횟수가 임계 넘으면 차단.
4. **Global diff trajectories 컴파일** — 워크스페이스 단위로 사용자 의도 trajectory 학습.
5. **모든 호출 async + boolean** — 인터페이스가 단순, 구현 swap 쉬움 (local memory / sqlite / 원격 등).

→ quanta agent loop의 `reflect-gate`, `closeout-guard`, `verify-guard` 모두 이 provider를 받아 cross-check 가능.

## 18. 향후 기능 개발 시 reference order

1. **9 heuristic 패턴**(특히 #8/#9) → reflect-gate(0098) v2: 거절 메모이즈 + 사용자 의도 거역 차단 → ADR 후보
2. **`isUserReadingCode` 60s idle** → quanta idle-monitor 모듈 → background task pause/resume
3. **Server-pushed config 패턴** → quanta에 per-session runtime config override (현재 `AgentConfig`는 시작 시 fixed)
4. **Chained followup** → EffectChannel(0093) 위에 accept-chain runner
5. **ControlToken mid-stream** → steering.ts BiDi 확장 (현재 단방향)
6. **Report Good/Bad** → eval schema additive
7. **Snooze 5min persistent** → 신규 모듈

## 19. 추가 dig 결과 (라운드별)

### 라운드 1 (이전 미확인 → 일부 해소)
| 항목 | 상태 | 결과 |
|---|---|---|
| `uL` enum 전수 | ✅ **해소** | **10값 verbatim** (§3 참조) |
| `StreamHoldCpp` kind | ✅ **해소** | **ServerStreaming** (`kind:On.ServerStreaming`) |
| `importPredictionConfig` 내부 | ⚠️ **부분** | `pythonEnabled` 확인 |

### 라운드 2 (이번 — heuristic 정밀)
| 항목 | 상태 | 결과 |
|---|---|---|
| `FBt` 단일 enum 9값 클레임 | ❌ **잘못** | 실제 `FBt` 7값(0~6) + 추가 enum(들) 3값 = 2개 enum 분리. 자세히 §6.1/6.2 |
| heuristic 적용 알고리즘 | ✅ **해소** | **provider-backed** (`everythingProviderService.onlyLocalProvider.runCommand(j6e.IsXxx, args)` async boolean). 줄 단위 per-line check |
| `recentlyRejectedEditThresholds.softRejectThreshold` | ✅ **확정** | 필드 존재, 사용 verbatim ("`numberOfTimesSoftRejectedThreshold: g.softRejectT...`") |
| `numberOfClearedSuggestionsSinceLastAccept` 리셋 path | ✅ **해소** | constructor 초기화 + `clearAndResetAllCppSuggestions` + `clearSuggestions` after accept 3 경로 (§4.1) |
| `lastEditTime` 갱신 path | ✅ **해소** | `Date.now()` on edit / `void 0` 명시 리셋 (§4.2) |
| `isValidCursorPredictionCase` body | ⚠️ **부분** | Bad Case 1 verbatim ("if predicted line in accepted cpp range → reject"), Bad Case 2/3은 truncated |
| `j6e` provider command enum | ✅ **존재 확인** | 최소 2값: `IsRevertingToRecentModel`, `IsSuggestingRecentlyRejectedEdit`. 전수는 추가 grep 필요 |

### 라운드 3 (이번 — 거의 모두 해소)
| 항목 | 상태 | 결과 |
|---|---|---|
| `j6e` 전체 provider command 종류 | ✅ **해소** | **10 commands verbatim** (§6.4): Ack/CompileGlobalDiffTrajectories/FormatDiffHistory/GetModelValue/InitModel/IsRevertingToRecentModel/IsSuggestingRecentlyRejectedEdit/RecordRejectedEdit/SetEnableCppIncludeUnchangedLines/SetEnableCppWhitespaceDiffHistoryMode |
| `CursorPredictionSource` enum | ✅ **해소** | 5값 verbatim (§10.1): UNSPECIFIED/ALWAYS_ON/ACCEPT/UNDO/EDITOR_CHANGE — 이전 "Heuristic 2값" 클레임은 source enum과 혼동 |
| `debouncer` 패턴 (2-tier) | ✅ **해소** | `clientDebounceDuration` + `totalDebounceDuration` 2-tier (§7.2), default `j$C`/`K$C` constants, cppConfig push로 변경 |
| `cppConfig` polling | ✅ **해소** | **60초마다 `fastPeriodicallyReloadCppConfig`** (§7.1), `cppConfig` RPC + `geoCppBackendUrl` dynamic |
| `supportsCpt:!0` 의미 | ✅ **해소** | 클라가 CPT(Cursor Prediction Tab) 지원 알림. 서버가 그에 맞는 config push |
| `ControlToken` BiDi vs unary | ✅ **해소** (정정) | BiDi 아님, **next-request-payload flag** (§10) — `StreamHoldCpp`도 ServerStream |
| RecordCppFateRequest 첫 필드 | ✅ **해소** | `request_id` (scalar string, no:1). 매 request 단위 fate 추적 |
| AddTabRequestToEvalRequest 첫 필드 | ✅ **해소** | `request_id` (scalar string, no:1) |
| `StreamCppRequest` 첫 필드 | ✅ **해소** | `current_file` (kind:"message", T:WD) — 29 필드 중 첫 번째 |
| `importPredictionConfig` 필드 | ⚠️ **부분** | `pythonEnabled` 1개만 식별 — 다른 언어 필드(`tsEnabled`/`rustEnabled`) 가능 |

### 라운드 4 (이번 — 마지막 정밀)
| 항목 | 상태 | 결과 |
|---|---|---|
| `j$C` / `K$C` debounce defaults ms | ✅ **해소** | **`j$C=25, K$C=60`** verbatim (§7.2) — client 25ms / total 60ms 극단 짧음 |
| `HGe` Report Good/Bad enum | ✅ **해소** | THUMBS_UP / THUMBS_DOWN 2값 + `reportGenerationFeedback(genId, thumb)` 단일 진입점 (§11) |
| `everythingProviderService` API | ✅ **해소** | `onlyLocalProvider` (메인) + `registerEverythingProvider` / `registerEverythingProviderAllLocal` / `unregisterEverythingProvider*` / `waitForEverythingProvider` / `waitForCommandEverythingProvider` / `provider` getter / `onDidChangeCommandProvider` — provider는 named가 **onlyLocalProvider 1개**만 |
| `importPredictionConfig` 다른 필드 | ✅ **부분해소** | `pythonEnabled` + `cppAutoImportEnabled` + `importPredictionEnabled` + `isCursorPredictionEnabled` (4 toggle 패턴) |

### 라운드 5+ 미해소 (낮은 우선순위, refinement)
| 항목 | 상태 | 비고 |
|---|---|---|
| `mergeBehavior` enum 값 verbatim | ❓ | `MergeBehavior` 클래스 / `MERGE_BEHAVIOR_*` 0 hit — 별도 minified 표기 / 다른 namespace 가능 |
| `Bad Case 2/3...` (isValidCursorPredictionCase) | ❓ | 함수 body truncate된 채로만 보임 — minified bracket-balance 복잡, 실행 trace로 추출 가능 |
| RVF LRU size cap | ❓ | `recentlyViewedFiles.length`/`slice` 호출 보임, 정확한 cap 상수 미식별 — runtime 측정 가능 |
| `MarkCppForEvalRequest` body | ❓ | typeName 위 batch에 0 hit — `MarkCppForEval` 자체가 더 새로운 minified 이름 가능 |
| `CursorPredictionConfigResponse.Heuristic` (source와 별개 enum) | ❓ | source enum은 §10.1 확정, 별도 Heuristic enum 존재 여부 unclear |
| `clearAndResetAllCppSuggestions` 발화 조건 전수 | ⚠️ | snooze 시작 + 큰 컨텍스트 변경 (앞에 본 것). 더 많은 호출처 있을 수 있음 |
| `CompileGlobalDiffTrajectories` 결과 schema | ❓ | trajectory 객체 shape 미식별 |

→ **구현 시작에 필요한 정보는 모두 해소**. 위 미해소는 *implementation refinement* 용 (필요 시 runtime instrumentation).

## 20. 구현 시 핵심 reference summary

quanta `EditHistoryProvider` 구현 시 **이 페이지만 보면 충분**:

| 무엇 | doc 위치 | 정확 값 (verbatim) |
|---|---|---|
| 10 trigger sources | §3 | uL.{Unknown,LineChange,Typing,OptionHold,LinterErrors,ParameterHints,CursorPrediction,ManualTrigger,EditorChange,LspSuggestions} |
| 2 client suppression gates | §4 | reject>20 / idle≥60_000ms |
| 카운터 리셋 3 path | §4.1 | constructor / clearAndResetAllCppSuggestions / clearSuggestions(after accept) |
| Snooze 5분 persistent | §5 | setTimeout 300_000ms + persistStorage("cppEnabled",false) |
| **9 heuristic 2 enum 분리** | §6.1/6.2 | FBt 7값(0-6) + 별도 enum 3값(LINT_OVERLAP/LOTS_OF_ADDED_TEXT/LINES_MISMATCH) |
| Heuristic 적용 알고리즘 | §6.3 | `cppConfig.heuristics.includes(FBt.X)` → `everythingProvider.onlyLocalProvider.runCommand(j6e.IsX, {relativePath, modelValue, ...thresholds})` async per-line |
| **10 provider commands (j6e)** | §6.4 | Ack/CompileGlobalDiffTrajectories/FormatDiffHistory/GetModelValue/InitModel/IsRevertingToRecentModel/IsSuggestingRecentlyRejectedEdit/RecordRejectedEdit/SetEnableCppIncludeUnchangedLines/SetEnableCppWhitespaceDiffHistoryMode |
| cppConfig 13+ 필드 + **60s polling** | §7/7.1 | fastPeriodicallyReloadCppConfig 60_000ms threshold |
| **2-tier debouncer 정확 ms** | §7.2 | **clientDebounceDuration=25ms (j$C), totalDebounceDuration=60ms (K$C)** |
| importPrediction 4 toggle | §7 | pythonEnabled / cppAutoImportEnabled / importPredictionEnabled / isCursorPredictionEnabled |
| 4 ControlToken (next-request flag) | §10 | COMPLETE/QUIET/LOUD/OP — BiDi 아님, 다음 요청 payload flag |
| 5 CursorPredictionSource | §10.1 | UNSPECIFIED/ALWAYS_ON/ACCEPT/UNDO/EDITOR_CHANGE |
| 4 CppFate values | §11 | UNSPECIFIED/ACCEPT/PARTIAL_ACCEPT/REJECT |
| 2 HGe ThumbsUp/Down | §11 | THUMBS_UP/THUMBS_DOWN — `reportGenerationFeedback(genId, thumb)` 단일 진입점 |
| everythingProviderService API | §17.4 | onlyLocalProvider (메인) + register/unregister + waitForProvider + onDidChangeCommandProvider |
| **EditHistoryProvider 인터페이스 (10 메서드)** | **§17.4** | **TypeScript verbatim — 그대로 구현 가능** |
| 9 흡수 패턴 + LOC 추정 | §17.1/17.2 | Top tier 6개 (전부 ML 인프라 0) + Medium tier 5개 |

다음 라운드 dig 시 위 명시.

---

**작성자 노트**: 이 doc은 향후 quanta 기능 개발 청사진 — *흡수 패턴 + 정확한 임계값 + IDE 구현 starting point* 우선. 매 적용 시 file:offset 재검증 권장 (Cursor 업데이트마다 minified 심볼명 변동).
