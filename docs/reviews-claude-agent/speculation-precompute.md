# Speculation / Precompute 시스템

추출 위치: `extracted-functions.js`

Claude Code v2.1.143 은 "필요해지기 전에 미리 한다"는 사변(speculative) 철학을 여러 서브시스템에 분산 구현한다. 이 문서는 그중 두 개의 **핵심·독립** 메커니즘을 다룬다:

1. **Speculative execution engine** (`speculativeExecEngine`/`speculativeExecEngine` fork) — 사용자가 다음에 칠 프롬프트를 LLM 으로 예측하고, **터미널이 유휴인 동안** copy-on-write 파일시스템 오버레이 위에서 그 프롬프트를 **미리 실행**해 둔다. (v2.1.143 에서 게이트로 **비활성** — 코드는 완비)
2. **Precomputed compaction** (`startPrecomputeFork`/`decideReactiveCompact`/`precomputeRegistry` 레지스트리) — 다음 턴에 PTL(prompt-too-long)이 올 것 같으면 백그라운드에서 요약을 미리 만들어 두고, 실제 PTL 시점에 "borrow" 해서 즉시 swap-in. (활성, Statsig 게이트)

그 외 prefetch 류(skill discovery / memdir)는 같은 철학의 일부이나 별도 문서에서 다룬다 — 본 문서 §3.5 에서 교차링크만.

용어: "확인" = 코드에서 직접 검증됨. "추정" = 정황 추론.

---

## 1. 호출 그래프

### 1.1. Speculative execution engine

```
(REPL idle, querySource="repl_main_thread")
HJ7 (10770)                              # 유휴 트리거 진입점
├─ vF() / G7()                           # 터미널 focus / 배경-비부착 상태 검사
├─ GL(reason)                            # suppressed 텔레메트리 (조기 종료)
├─ cg(ctx)                               # cacheSafeParams 빌더 (9839)
├─ ZX8(abort, messages, getAppState, params, "cli")  (10768)  # suggestion 생성 게이트
│   ├─ H8(...assistant) < 2 ⇒ "early_conversation"
│   ├─ LG($).isApiErrorMessage ⇒ "last_response_error"
│   ├─ n05($) ⇒ 기타 suppress
│   ├─ MX8(appState) (10766)             # 6-조건 suppress 게이트
│   └─ fX8(abort, "user_intent", params) (10775)   # ← 실제 LLM 호출
│       └─ PL({querySource:"prompt_suggestion", forkLabel:"prompt_suggestion",
│              canUseTool: 항상 deny, skipTranscript, skipCacheWrite})
│       └─ XX8(suggestion) (10776)       # 12-규칙 품질 필터 (suppress)
├─ setAppState ⇒ promptSuggestion 슬롯에 표시 (ghost text)
├─ c05(...)                              # (배경 케이스) pipelined 보조
└─ if JX8() && suggestion                # ← 마스터 게이트 (현재 false)
    └─ DX8(suggestion, ctx, setAppState, isPipelined=false, params)  (10762)
        ├─ JX8() (10752)  ⇒ return "[Speculation] enabled=false"  ★ 하드 비활성
        ├─ vG(setAppState)               # 기존 speculation 중단
        ├─ y76(id) (10739)               # overlay dir = <PI>/speculation/<pid>/<id>
        ├─ setAppState ⇒ speculation:{status:"active", ...}
        ├─ PL({promptMessages:[D6(suggestion)], querySource:"speculation",
        │      forkLabel:"speculation", maxTurns:b05=20,
        │      canUseTool: 사변용 커스텀 정책 (아래)})
        │   └─ canUseTool 정책:
        │       - Edit/Write/NotebookEdit (u05) ⇒ overlay 로 redirect, 권한모드
        │         아니면 boundary{type:"edit"} + abort
        │       - Read/Glob/Grep/ToolSearch/LSP/TaskGet/TaskList (m05) ⇒ allow
        │         (cwd 밖이면 overlay 우회 read-only allow)
        │       - Bash (Q2) ⇒ readonly 명령만 allow, 아니면 boundary{type:"bash"}
        │         + abort; backgrounded shell 도 boundary
        │       - 그 외 ⇒ boundary{type:"denied_tool"} + abort
        │   └─ onMessage: A.current 누적, ≥ x05=100 메시지면 abort
        ├─ jLH(...) ⇒ boundary{type:"complete"} 기록
        └─ Q05(...) (10756)              # 다음-프롬프트 pipelined 사변 (chained)

(사용자가 실제로 그 프롬프트를 입력/수락하면)
sj7 (10762)                              # handleSpeculationAccept
├─ d05(speculation, setAppState, ...) (10760)   # 결과 commit
│   ├─ p05(overlayDir, writtenPaths, cwd) (10739)  # overlay → 실제 cwd 복사
│   │   (symlink escape 방지 검사 다수)
│   ├─ $j_(overlayDir)                   # overlay rm -rf
│   ├─ speculationSessionTimeSavedMs += M
│   └─ h76(id, "accepted", ...)          # tengu_speculation
├─ F05(messages)                         # orphan tool_use/result 정리
├─ 메시지 주입 ⇒ setMessages
└─ pipelinedSuggestion 있으면 promote + DX8 재귀(chained 사변)

vG(setAppState, reason="user_typed") (10760)   # abortSpeculation 본체
├─ speculation.status!=="active" ⇒ noop
├─ h76(id, "aborted", ...)               # tengu_speculation
├─ speculation.abort()                   # 포크된 PL 의 AbortController
├─ $j_(y76(id))                          # overlay dir 삭제
└─ speculation := DLH (idle 리셋)
```

### 1.2. Precomputed compaction

```
Bq3 (14057) turn 시작부
├─ g = Z.precomputeSourceKey!==void 0 && F?.compacted!==true && !mD8(z)
│       # = isPreFirstCompactFork (확인)
├─ autocompact (Ia7) 결과로 e=compactionResult, HH=consecutiveFailures
├─ if b47({compactionResult:e, isPreFirstCompactFork:g, ...}) (9874)
│   └─ x47({querySource:z, messages:x, cacheSafeParams:{...,toolUseContext:Z}}) (9875)
│       ├─ uD8() / mD8(_) / rI.has(sourceKey) 가드
│       ├─ sourceKey = _96(O.agentId) = agentId ?? "main"
│       ├─ z = new AbortController; w = fw5(O, z)  # onCompactEvent:void 0
│       ├─ rI.set(sourceKey, {status:"pending", precomputedAtUuid, ...})
│       ├─ tengu_precomputed_compact_started
│       └─ (async IIFE):
│           ├─ lg({trigger:"auto"}) — PreCompact hook (blockedBy면 폐기)
│           ├─ tq6(q, j, {customInstructions}) — reactive 본체 (요약 모델)
│           ├─ 실패 ⇒ tengu_precomputed_compact_failed + rI 삭제
│           └─ 성공 ⇒ H96 ⇒ rI[sourceKey].status="ready" + result
│                     tengu_precomputed_compact_ready

(다음 턴 또는 같은 세션에서 PTL 발생 시 — Bq3 reactive 경로)
yield* rY6(__ => u47({borrowFrom: g ? Z.precomputeSourceKey : undefined, ...})) (9883)
├─ Pw5(borrowFrom, signal) (9879)        # 부모 fork 의 precompute 빌려옴 (pending이면 대기)
├─ Ww5(agentId, signal) (9881)           # 자기 agent precompute 소비 (consume, rI 삭제)
├─ Zw5(messages, precomputedAtUuid) (9883)   # precompute 시점 이후 메시지 추적
│   └─ uuid 못 찾으면: borrowed면 tengu_precompute_borrow_boundary_miss
│      아니면 m47(...,"boundary_uuid_missing") (9885)
└─ swap = {compactResult, messagesSince, leadMs, totalMs, borrowed}
yield* rY6(__ => o47({precomputed: swap, ...}))     # swap 결합 / fallback 동기 요약
⇒ 성공 시 D.transition.reason = "precomputed_compact_swap"
```

핵심 위치 인덱스:

| ID | 라인 | 역할 |
|---|---|---|
| `HJ7` | 10770 | 유휴 시 prompt suggestion + speculation 트리거 |
| `ZX8` | 10768 | suggestion 생성 게이트 (8 suppress 사유) |
| `fX8` | 10775 | suggestion LLM 호출 (`speculativeExecEngine` fork, `prompt_suggestion`) |
| `XX8` | 10776 | suggestion 품질 필터 (12 규칙) |
| `speculationEnabledGate` | 10752 | **speculation 마스터 게이트 — `return ...,!1` (하드 false)** |
| `speculativeExecEngine` | 10762 | speculative execution 본체 (overlay + fork) |
| `vG` | 10760 | `abortSpeculation` 구현 (abort + overlay rm) |
| `sj7` | 10762 | handleSpeculationAccept (커밋 + chained) |
| `d05` | 10760 | speculation 결과 commit (`p05` overlay→cwd) |
| `Q05` | 10756 | pipelined(연쇄) suggestion 생성 |
| `p05` | 10739 | overlay 파일 → 실제 cwd 안전 복사 |
| `y76` | 10739 | overlay 경로 빌더 |
| `h76` | 10743 | `tengu_speculation` 텔레메트리 |
| `MX8` | 10766 | suggestion suppress 게이트 (6 조건) |
| `S76` | 10764 | prompt_suggestion init 게이트 (env + Statsig) |
| `decideReactiveCompact` | 9874 | precompute fork 트리거 결정 (8 조건) |
| `startPrecomputeFork` | 9875 | precompute fork 시작 (백그라운드 요약) |
| `precomputeRegistry` | 9892 (init) | `Map<sourceKey, PrecomputeEntry>` 레지스트리 |
| `xD8` | 9892 (init) | `Map<sourceKey, number>` 시도 횟수 |
| `_96` | 9870 | sourceKey 정규화 (`x ?? "main"`) |
| `H96` | 9876 | rI 엔트리 안전 mutate (pending 검증) |
| `Pw5` | 9879 | borrow await (부모 fork) |
| `Ww5` | 9881 | own precompute await + consume |
| `reactiveCompactPhaseA` | 9883 | reactive phase A (swap-in 시도) |
| `Zw5` | 9883 | precomputedAtUuid 이후 메시지 slice |
| `m47` | 9885 | precompute discard 텔레메트리 |
| `q96` | 9886 | precompute abort (cleanup) |
| `p47` | 14778 | precompute 시작 토큰 임계 |
| `r13` | 14774 | `precomputeBufferFraction` (`tengu_amber_rokovoko`, 기본 `uE8=0.2`) |
| `uD8` | 9871 | Statsig `tengu_sepia_moth` (precompute 활성) |
| `Nw_` | 9889 | Statsig `tengu_cobalt_raccoon` (reactive 활성) |
| `K96` | 14766 | Statsig `tengu_amber_redwood2` (precompute 차단 조건) |

---

## 2. 핵심 로직

### 2.1. Speculative execution engine — 무엇을 사변하는가

`abortSpeculation` 은 `ToolUseContext` 의 필드다 (확인). REPL 메인 컨텍스트(`replCtxBuilder`, line 21005/21007)에서 `abortSpeculation:()=>vG($)` 로 생성되어, `forkToolUseContext` fork 빌더(9845)가 서브에이전트 컨텍스트로 **참조 그대로 전파**(`abortSpeculation:H.abortSpeculation`)한다. 즉 사변은 메인 세션 1개 단위로만 존재하고, 서브에이전트는 그 메인 사변을 중단시킬 수 있는 핸들만 받는다.

**사변의 정체 (확인)**: 진짜 speculative *model streaming* (사용자 확인 전에 응답 생성 시작)이다. 단 일반 턴이 아니라 **"사용자가 다음에 칠 프롬프트"를 LLM 으로 먼저 예측**한 뒤(`fX8` → `i05.user_intent` = `tj7` = `[SUGGESTION MODE: Suggest what the user might naturally type next...]`), 그 예측 프롬프트를 **실제 에이전트 루프(`speculativeExecEngine` fork)로 미리 돌려서 결과 메시지까지 만들어 둔다**(`speculativeExecEngine`). 사용자가 실제로 그 프롬프트(또는 충분히 유사한 것)를 입력하면 `sj7` 가 이미 만들어진 메시지를 그대로 주입해 모델 왕복 한 번을 절약한다(`speculationSessionTimeSavedMs` 누적).

**부수효과 격리 (확인)** — 사변은 진짜 도구를 실행하므로 위험하다. 격리 메커니즘:

- **Copy-on-write filesystem overlay**: `y76(id)` = `<PI()>/speculation/<pid>/<id>`. Write/Edit/NotebookEdit(`u05`) 도구의 대상 경로는 overlay 로 redirect 되고, Read 도구도 이미 overlay 에 write 된 파일은 overlay 본을 읽는다. 사변이 수락되면(`d05`→`p05`) overlay 파일을 실제 cwd 로 **심링크 escape 검사를 거쳐** 복사하고, 거부/중단되면 overlay 를 `rm -rf`(`$j_`).
- **권한 boundary**: 사변은 권한 프롬프트를 띄울 수 없으므로 위험 도구에서 멈춘다. file edit(권한모드 아니면), backgrounded/non-readonly bash, 그 외 unknown tool 은 모두 `boundary` 를 기록하고 즉시 `abort`. `boundary.type` ∈ `edit|bash|denied_tool|complete`.
- **자원 한계**: `maxTurns=b05=20`, 누적 메시지 `≥ x05=100` 이면 abort.
- **읽기 전용 bash 판정**: `Bash`(Bash)는 `k76` 분류기, 그 외는 `M.isReadOnly(parsed)` 로 판정.

**현재 상태 (확인)**: `JX8()` 는 `function JX8(){return N("[Speculation] enabled=false"),!1}` — **무조건 false**. `speculativeExecEngine` 첫 줄이 `if(!JX8())return` 이므로 v2.1.143 에서 speculative execution 엔진은 **완전히 구현되었으나 게이트로 죽어 있다**. 단 그 앞단 *suggestion* 생성(`ZX8`/`fX8`)은 `S76()`(env `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` + Statsig `tengu_chomp_inflection`)로 별도 게이트되어 ghost-text 만 표시될 수 있다 — suggestion ≠ speculation. (추정: speculation 은 위험도가 높아 더 보수적으로 비활성)

**pipelined(연쇄) 사변 (확인)**: `Q05`/`sj7` 가 사변이 `complete` 로 끝나면 *그 결과 위에서* 또 다음 프롬프트를 예측·사변한다(`isPipelined:true`). 멀티-스텝 미리보기.

### 2.2. Precomputed compaction — borrow 메커니즘

이건 사변의 다른 형태: 모델 호출이 아니라 **요약 작업을 미리** 한다.

`decideReactiveCompact`(9874)가 다음 8조건을 **모두** 만족하면 precompute 가 가치 있다고 판단:

```
compactionResult === undefined          # 이번 턴 autocompact 안 함
&& !isPreFirstCompactFork               # ← g
&& consecutiveFailures === undefined    # 직전 compact 실패 이력 없음
&& !hasAttemptedReactiveCompact
&& lastTransitionReason !== "precomputed_compact_swap"
&& uD8()                                # Statsig tengu_sepia_moth
&& isReactiveFallbackEnabled            # Nw_() = Statsig tengu_cobalt_raccoon
&& p47(contextTokens, model, autoCompactWindow)   # 토큰이 precompute 시작점 도달
```

`p47`(14778) 임계: `p47(H,_,q){ T=lHH(model,window); z = (zKH && !oiH) ? O_K(T,K) : BP_(T,K); return H>=z }`
- `BP_(H,_)` = `H - 13000` (autocompact 발동선보다 13k 토큰 **이전**에 precompute 착수)
- `O_K(H,_)` = `min(H - round(H * precomputeBufferFraction), BP_(H))`
- `precomputeBufferFraction` = `r13()` = Statsig `tengu_amber_rokovoko`, 기본 `uE8 = 0.2` (확인). 즉 윈도우의 20% 여유를 두고 더 일찍 착수하는 모드.

`startPrecomputeFork`(9875) 동작 (확인):
- `sourceKey = _96(toolUseContext.agentId)` = `agentId ?? "main"`.
- 이미 `rI.has(sourceKey)` 면 중복 방지로 skip.
- `precomputedAtUuid = messages.at(-1).uuid` — 이 시점 기준으로 요약했음을 기록.
- 백그라운드 IIFE: `lg({trigger:"auto"})`(PreCompact hook) → `tq6(messages, params, {customInstructions})`. **`tq6` 는 reactive 와 동일한 요약 구현** (autocompact 의 `autocompactImpl` 와 다름; compaction-system.md §1.5 참조). 즉 precompute 가 쓰는 **모델은 reactive 요약 모델과 같다** — `tq6` → `Dw5` → `PL({forkLabel:"reactive-compact", maxTurns:1, querySource:"compact"})`. 별도 cheap 모델이 아니라 메인 요약 경로를 그대로 fork.
- `rI.set(sourceKey, {status:"pending", precomputedAtUuid, preCompactTokens, startedAt, abortController, settled})`. 완료 시 `H96` 가 `status:"ready", result, readyDurationMs` 로 전이.

**Borrow 라이프사이클 (확인)**:
- PTL 발생 → `reactiveCompactPhaseA`(9883) 가 `borrowFrom !== undefined ? rI.get(borrowFrom) : Xw5(agentId)` 의 status 가 `pending` 이면 사용자에게 `compact_start`/`sdk_status:"compacting"` UI 를 먼저 emit.
- `borrowFrom` 있으면 `Pw5(borrowFrom, signal)` — 부모(또는 지정 소스)의 precompute 를 **빌려옴**: pending 이면 `settled` 와 abort 를 race 해서 대기, ready 면 `{ready, statusAtPTL}` 반환. **엔트리를 삭제하지 않음**(다른 borrower 가능).
- 자기 것은 `Ww5(agentId, signal)` — pending 대기 후 **소비(consume): `rI.delete`**.
- `Zw5(messages, ready.precomputedAtUuid)` — 메시지 배열에서 그 uuid 를 찾아 *이후* 메시지를 slice. 못 찾으면(메시지가 그새 바뀜) `boundary_uuid_missing` 으로 폐기(borrowed 면 `tengu_precompute_borrow_boundary_miss`).
- 성공 swap: `{compactResult, messagesSince, leadMs:(ptlDetectedAt - startedAt), totalMs:readyDurationMs, borrowed}`. `leadMs` 가 곧 절약된 시간.

### 2.3. forkPointUuid / isPreFirstCompactFork — 세션 fork 의 의미

`runTurnLoop` 시그니처에서 `forkPointUuid:j` 가 디스트럭처되어(14057), `iI(...)` 호출(14064, `speculativeExecEngine` 내부의 turn-loop entry)과 advisor payload(19057)에 그대로 전달된다 (확인). `speculativeExecEngine`(9847)에서 `L = Z.at(-1)?.uuid` = **forkContextMessages 의 마지막 메시지 uuid** = "이 fork 가 부모 대화의 어느 지점에서 갈라져 나왔는지" 표시.

여기서 "fork" = **대화 분기**다(resume 아님). `speculativeExecEngine` 은 부모 컨텍스트(`forkContextMessages = Z`)에 새 프롬프트(`H`)를 이어붙여 **별도 에이전트 인스턴스로 실행**하되 부모 transcript 를 오염시키지 않는다. 사용처: subagent(`Agent`), prompt suggestion, speculation, reactive/precompute 요약 모두 `speculativeExecEngine` fork. `forkPointUuid` 는 텔레메트리/transcript 상에서 분기점을 식별하는 메타.

`isPreFirstCompactFork`(= `g`) 정의 (확인):
```
g = Z.precomputeSourceKey !== void 0 && F?.compacted !== true && !mD8(z)
```
- `precomputeSourceKey` 가 컨텍스트에 박혀 있다 = 이 fork 는 **부모가 precompute 를 진행 중인 상태에서 갈라져 나온 fork**.
- `F?.compacted !== true` = 아직 한 번도 compact 안 됨 (= "pre-first-compact").
- `!mD8(z)` = querySource 가 `"compact"` 아님.

`g === true` 면:
1. `decideReactiveCompact` 가 false 반환 → 이 fork 는 **자기 precompute 를 시작하지 않음** (부모 것을 빌릴 거니까 중복 낭비 방지).
2. PTL 발생 시 `reactiveCompactPhaseA` 에 `borrowFrom: Z.precomputeSourceKey` 전달 → **부모의 precompute 를 borrow**.

즉 fork 가 부모의 사변 작업을 상속받는 cross-session 사변 공유 메커니즘이다.

### 2.4. precomputeSourceKey — borrow 캐시 키

(확인) `forkToolUseContext` fork 빌더(9847)에서:
```
precomputeSourceKey: T?.precomputeSourceKey ?? P.agentId ?? "main"
```
`speculativeExecEngine`(9847)이 `W = ED8(P, {..., precomputeSourceKey: T?.precomputeSourceKey ?? P.agentId ?? "main"})` 로 fork 컨텍스트를 만들 때, 부모의 `precomputeSourceKey`(또는 부모 agentId, 또는 `"main"`)를 자식에 전파. 이 키가 `rI: Map<sourceKey, PrecomputeEntry>` 의 조회 키와 동일 네임스페이스(`_96(agentId)`도 `?? "main"`). 라이프사이클:

- **생성**: 메인 = `"main"`, 서브에이전트 = `agentId`. fork 시 부모 키 상속.
- **등록**: `startPrecomputeFork` 가 `rI.set(sourceKey, pending)`.
- **차용**: 같은 키면 `Ww5`(consume), 부모 키 명시면 `Pw5`(non-consume borrow).
- **폐기**: `q96(agentId, reason, qs)` — `reason ∈ subagent_exit|post_compact_cleanup|...` 시 `rI.delete` + abort. `subagent_exit` 면 `xD8`(시도 횟수)도 삭제.
- 메인 컨텍스트(14057)에서 fork 가 아니면 `precomputeSourceKey: void 0` → `g=false` → 일반 precompute 경로.

---

## 3. State / Schema / 비용·게이팅

### 3.1. speculation 앱 상태 (확인 — `speculativeExecEngine`/`vG`)

```ts
type SpeculationState =
  | DLH                                  // = idle sentinel (status:"idle")
  | {
      status: "active",
      id: string,                        // randomUUID().slice(0,8)
      abort: () => void,                 // 포크 PL 의 AbortController.abort
      startTime: number,
      messagesRef: { current: Message[] },     // 사변이 만든 메시지 누적
      writtenPathsRef: { current: Set<string> }, // overlay 에 복사된 상대경로
      boundary: null | {
        type: "edit",  toolName, filePath, completedAt
      } | { type: "bash", toolName, command, completedAt }
        | { type: "denied_tool", toolName, detail, completedAt }
        | { type: "complete", completedAt, outputTokens },
      suggestionLength: number,
      toolUseCount: number,
      isPipelined: boolean,
      contextRef: { current: ToolUseContext },
      pipelinedSuggestion?: { text, promptId, generationRequestId }
    }
```
앱 상태에 `speculationSessionTimeSavedMs`(누적 절약 ms), `promptSuggestion:{text,promptId,shownAt,acceptedAt,generationRequestId}` 동거.

### 3.2. PrecomputeEntry (`precomputeRegistry`, 확인)

```ts
type PrecomputeEntry =
  | { status:"pending", precomputedAtUuid:string, preCompactTokens:number,
      startedAt:number /*performance.now()*/, abortController:AbortController,
      preCompactHookDisplay?:string, settled:Promise<void> }
  | { status:"ready", result:tq6Result, readyDurationMs:number,
      preCompactHookDisplay?:string, precomputedAtUuid, preCompactTokens,
      startedAt, abortController, settled }
```
`xD8: Map<sourceKey, number>` — `precomputeAttemptNumber` 텔레메트리용 시도 카운터.

### 3.3. 텔레메트리 (확인)

Speculation:
```
tengu_speculation       {speculation_id, outcome:"accepted"|"aborted"|"error",
                          duration_ms, suggestion_length, tools_executed,
                          completed, boundary_type, boundary_tool, boundary_detail,
                          time_saved_ms?, message_count?, is_pipelined,
                          abort_reason?|error_type?|error_phase?}
tengu_prompt_suggestion {source, outcome:"accepted"|"ignored"|"suppressed",
                          reason?, prompt_id, similarity, timeToAcceptMs?}
tengu_prompt_suggestion_init {enabled, source:"env"|"growthbook"|"setting"|...}
tengu_prompt_suggestion_generate / _speculate (perf marker via EH/mH/M6)
```
Precompute:
```
tengu_precomputed_compact_started   {preCompactTokens, messageCount, querySource,
                                      precomputeAttemptNumber}
tengu_precomputed_compact_ready     {durationMs, attempts, groupsPreserved,
                                      totalGroups, ...}
tengu_precomputed_compact_failed    {reason, durationMs, clearReason?, ...}
tengu_precomputed_compact_discarded {reason:"boundary_uuid_missing"
                                      |"post_compact_cleanup"|"subagent_exit"|...,
                                      ageMs, readyDurationMs, ...}
tengu_precompute_borrow_boundary_miss {querySource}
```

### 3.4. 비용 / 리스크 모델 (확인 + 추정)

사변은 **사용 안 되면 토큰·시간 낭비**다. 게이팅 강도:

**Speculative execution (`speculativeExecEngine`)** — 가장 비싸고(전체 에이전트 루프 fork, maxTurns 20), 가장 보수적으로 게이팅:
- `JX8()` 마스터 게이트가 **하드코딩 false** → v2.1.143 에서 사실상 0 비용 (실행 안 됨). (추정: 위험도(파일 부수효과)·비용 대비 적중률이 충분치 않아 출하 비활성, 코드만 선반영.)
- (가정상 활성 시) 유휴·focus 조건(`HJ7`: `repl_main_thread` + 터미널 focused + 비-blocked) 으로 사용자가 응답을 안 보는 시간에만 착수 → 시간 낭비는 숨겨지나 토큰은 소모.
- suggestion 단계만이라도 `S76()`: env `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` 우선, 아니면 Statsig `tengu_chomp_inflection`, non-interactive/swarm-teammate 면 비활성.
- `XX8` 12-규칙 품질 필터 + `MX8` 6-조건 suppress(권한 대기/elicitation/plan 모드/rate limit 등)로 저품질 사변을 사전 차단.

**Precomputed compaction (`startPrecomputeFork`)** — 비용은 요약 1회(reactive 와 동일 모델·경로); PTL 이 실제로 와야만 본전:
- 이중 Statsig: `tengu_sepia_moth`(`uD8`, precompute) **AND** `tengu_cobalt_raccoon`(`Nw_`, reactive fallback). 둘 중 하나라도 off 면 precompute 무의미하므로 안 함.
- `tengu_amber_redwood2`(`K96`) 가 true 면 `uD8()` 가 false 반환 → precompute 차단 (kill-switch 추정).
- `tengu_amber_rokovoko`(`r13`, 기본 0.2) 로 착수 시점(버퍼)을 서버측에서 튜닝 — 너무 일찍 시작하면 메시지가 바뀌어 `boundary_uuid_missing` 폐기, 너무 늦으면 PTL 전에 ready 못 됨.
- 중복 방지: `rI.has(sourceKey)` 면 skip, `isPreFirstCompactFork` fork 는 자기 것 안 만들고 부모 것 borrow.
- 손절: PreCompact hook `blockedBy`, abort, `consecutiveFailures` 이력이면 즉시 폐기·미착수.
- 폐기 사유 전부 텔레메트리(`tengu_precomputed_compact_discarded`)로 적중률·낭비율 모니터링 — 사변 경제성을 서버에서 관측·조정하는 구조.

종합: 두 사변 모두 **Statsig 게이트 + 적중/폐기 텔레메트리 + 유휴·중복·실패 가드** 로 다층 통제된다. 비용이 큰 speculative execution 은 아예 게이트로 꺼두고, 비용이 상대적으로 작은 precompute compaction 만 게이트 뒤에서 운용한다.

### 3.5. 같은 철학의 다른 prefetch (교차링크)

본 문서의 두 메커니즘 외에, "미리 가져온다" 계열로 다음이 별도 문서에 있다:

- **Skill discovery prefetch**: `runTurnLoop` 턴 시작부 `Uy8?.().startSkillDiscoveryPrefetch(null, W, Z)`(14057). 스킬 디스커버리를 백그라운드로 미리 — [`skill-system.md`](skill-system.md) 참조.
- **Memdir prefetch**: `using P = ga7(...)`(14303). memory-directory 결과를 ES2026 disposable 로 백그라운드 prefetch 후 한 번 consume — [`agent-loop-memdir-prefetch.md`](agent-loop-memdir-prefetch.md) 참조.

이 둘은 부수효과·토큰 비용이 거의 없는 read-only prefetch 라 게이팅이 가볍다(`tengu_moth_copse` 하나 등). speculative execution / precompute compaction 과 같은 "선제 실행" 철학이되 리스크 스펙트럼의 반대쪽 끝.

### 3.6. 사변이 아닌 것: `cacheBreakerPhrase`

`cacheBreakerPhrase`(ToolUseContext `getCacheBreakerPhrase`, REPL 상태)는 이름과 달리 **사변/캐시 워밍과 무관**하다. 시스템 프롬프트 끝에 임의 문구를 덧붙여 **프롬프트 캐시를 일부러 무효화**하는 디버그/수동 장치(`tD(q.cacheBreakerPhrase)`, 15875)다. 사변이 캐시를 *데우는* 것의 정반대 — 캐시를 *깨는* 것이라 본 시스템에 포함되지 않음 (확인).

speculative **cache warming** 전용 메커니즘은 추출본에서 별도로 발견되지 않음. 단 precompute 의 reactive 요약 경로(`tq6`→`Dw5`→`speculativeExecEngine`)는 `tengu_compact_cache_prefix` 게이트로 prompt-cache prefix 공유를 시도하므로(compaction-system.md §3.6), precompute 가 실행되면 그 부산물로 캐시가 채워질 수는 있음 (추정).

---

## 4. 차이점 (v0.2.8 대비)

v0.2.8:
- speculative execution 엔진 **없음** (prompt suggestion / ghost-text / overlay 전무).
- precomputed compaction **없음** — `/compact` 수동 1종.
- fork 개념은 subagent 1종(`AgentTool`, sidechain log)뿐, `forkPointUuid`/`precomputeSourceKey`/`isPreFirstCompactFork` 메타 없음.
- prefetch 류(skill/memdir) 없음.

v2.1.143 신규:
- **Speculative execution engine** (`speculativeExecEngine`): 다음 프롬프트 LLM 예측 + copy-on-write overlay 위 미리 실행 + 권한 boundary + pipelined 연쇄 + `speculationSessionTimeSavedMs` 측정. **단 `JX8()` 게이트 하드 false 로 비활성** (코드 완비, 미출하).
- **Precomputed compaction** (`startPrecomputeFork`/`precomputeRegistry`): PTL 예측 시 백그라운드 요약 선제 생성 + `precomputeSourceKey` 기반 cross-fork borrow + `precomputedAtUuid` 경계 추적 + 폐기 사유 텔레메트리. (Statsig 게이트로 활성)
- **`forkPointUuid`** 메타: 모든 `speculativeExecEngine` fork 가 분기점 uuid 를 transcript/텔레메트리에 기록.
- **`isPreFirstCompactFork`**: fork 가 부모의 in-flight precompute 를 상속·borrow 하고 자기 것은 안 만드는 중복 제거 규칙.
- 사변 경제성의 **다층 게이팅**: env → Statsig(`tengu_chomp_inflection`/`tengu_sepia_moth`/`tengu_cobalt_raccoon`/`tengu_amber_redwood2`/`tengu_amber_rokovoko`) → 유휴·focus·suppress 가드 → 적중/폐기 텔레메트리.

### 추정 / 확인 필요

- speculative execution 의 `i05` 프롬프트 본문은 `tj7` 한 줄(`[SUGGESTION MODE: ...]`)만 확인. `user_intent`/`stated_intent` 두 키가 같은 `tj7` 을 가리킴 (확인) — 스테이지별 차별 프롬프트는 아직 미구현 (추정).
- `JX8()` 하드 false 가 빌드 상수인지 런타임 게이트의 컴파일 흔적인지 단정 불가 — 함수 본문에 분기 없이 `return ...,!1` 이므로 **빌드 시점 비활성**으로 확인. 향후 버전에서 Statsig 연결될 자리로 추정.
- precompute 가 쓰는 모델: `tq6`→`Dw5`→`PL({querySource:"compact"})` 이므로 메인 요약 경로와 동일 모델 (확인). 별도 저비용 모델 미사용 (확인).
- `DLH`(idle sentinel)·`n05`(suggestion suppress 보조) 본문 미추출 — 의미만 정황 확인.
