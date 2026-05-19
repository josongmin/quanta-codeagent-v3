# Bq3 — compaction 평탄화 / turn boundary / blocking limit / 표준 에러 본문

추출 위치: [`extracted-functions.js:14057`](../../extracted-functions.js#L14057) (`runTurnLoop`) 와 그 주변 헬퍼.
agent-loop.md 의 mechanics 보강: AKH / Uq3 / zNH / 에러 메시지 본문 / pJH·mJH·$NH / 메시지 빌더 / `v5("query_*")` 마커.

---

## 1. 호출 그래프

```
Bq3 (14057)
├─ AKH(compactionResult)   ── compact 결과 → Message[] 평탄화 (5종 concat) [14736]
├─ Uq3(messages)           ── 마지막 turn boundary index 탐색 [14058]
├─ zNH(tokens, model, win) ── context window pressure level 계산 [14777]
│    ├─ gE8()              ── { enabled, precomputeBufferFraction, testPctOverride, testBlockingOverride } [14775]
│    ├─ lHH(model, win)    ── effective window (window - reserved) [14770]
│    ├─ i13(model)         ── 모델 raw context size - reserved [14771]
│    └─ T_K(H,_,q,K)       ── { level, pctLeft } 본체 [14764]
│         └─ BP_(_, q)     ── compact 임계 raw 계산 [14762]
├─ y1({content, error?, errorDetails?, now, uuid})
│      → ApiErrorMessage (type:"assistant", isApiErrorMessage:true) [15502]
├─ D6({content, isMeta?, isCompactSummary?, toolUseResult?, mcpMeta?, ...})
│      → UserMessage (type:"user", role:"user") [15503]
├─ T9(attachment)
│      → AttachmentMessage (type:"attachment") [14331]
├─ VO(text, level, toolUseID?, preventContinuation?)
│      → SystemMessage (type:"system", subtype:"informational") [15579]
├─ B9K({content, isApiErrorMessage?, apiError?, error?, errorDetails?, usage?})
│      → AssistantMessage 베이스 빌더 [15500]
├─ mJH(toolUseContext, querySource)  ── 턴 abort 마킹 [14051]
├─ pJH(toolUseContext, querySource, errMsg) ── API 실패 영속화 [14052]
├─ $NH  ── StopFailure hook 실행기 (= bp3.StopFailure) [DEK 모듈, 18831]
├─ vw_(trigger, preTokens, logicalParentUuid?, userContext?, msgsSummarized)
│      → compact_boundary 메시지 [15589]
└─ Ju7  ── UI 컴포넌트: "✻ Conversation compacted (ctrl+o for history)" [12757]
```

핵심 비교: `abortCleanup` 는 turn-aborted 마킹 (`u4H().markTurnAborted`), `persistTurnFailure` 는 API failure 영속화 (`u4H().markApiFailure`), `runStopFailureHook` 는 **StopFailure hook 실행** — 본 시스템의 hook event 29종 중 하나이다 (`bp3.StopFailure = $NH`). 호출 의도는 "터미널 에러로 Stop hook 의 failure 변형이 트리거" 이다 — agent-loop.md 의 "set last error in app state" 표현은 부정확하며, 실제로는 **hook 호출**이다 — 확인.

---

## 2. 핵심 로직

### 2.1 `AKH(compactionResult)` — compact 결과 평탄화 [14736]

verbatim (확인):
```js
function AKH(H){return[H.boundaryMarker,...H.summaryMessages,...H.messagesToKeep,...H.attachments,...H.hookResults]}
```

5종 concat 순서 (확인):

| 순서 | 필드 | 타입 / 의미 |
|---|---|---|
| 1 | `boundaryMarker` | 단일 `{type:"system", subtype:"compact_boundary"}` 메시지 — `vw_()` 가 생성 |
| 2 | `...summaryMessages` | `[user msg with <summary> body, isCompactSummary:true, ...]` (Rw_ 가 만든다 — 확인 필요) |
| 3 | `...messagesToKeep` | 보존된 꼬리 메시지들 (`bw5()` 로 usage 토큰 0 마스킹) |
| 4 | `...attachments` | 재투입된 todos / plan / skills / agentInstruction / 파일 attachment |
| 5 | `...hookResults` | SessionStart hook (`um("compact",...)`) 결과 메시지 |

순서 의미 (추정):
- **`boundaryMarker` 가 맨 앞** — UI 가 `compact_boundary` 마커 이전 메시지를 transcript-only 로 접고, 새 컨텍스트의 시각적 시작점을 만든다.
- **요약 메시지를 그 다음** — 모델이 첫 read 위치에서 바로 요약을 보게 한다. `isCompactSummary:true` 인 user role 메시지.
- **kept messages** — autocompact 의 경우 거의 비어 있음 (사실상 0). reactive `tq6` 는 `O.slice(J)` 형태의 보존 그룹을 다시 user/assistant 페어로 펴서 넣음.
- **attachments → hookResults** — 시스템 상태 재투입. todos/plan/skills/file 상태 등이 요약 다음에 와야 모델이 컨텍스트 안에서 "이건 시스템 상태" 로 분리해 읽음.

#### 2.1.1 `boundaryMarker` 본체 (`vw_`)

verbatim (확인):
```js
function vw_(H,_,q,K,O){return{
  type:"system",
  subtype:"compact_boundary",
  content:"Conversation compacted",
  isMeta:!1,
  timestamp:new Date().toISOString(),
  uuid:gL.randomUUID(),
  level:"info",
  compactMetadata:{trigger:H, preTokens:_, userContext:K, messagesSummarized:O},
  ...q&&{logicalParentUuid:q}
}}
```

`vw_` 호출자 (`autocompactImpl` 본체 내부) 가 만든 직후, `aD8(boundaryMarker, lastUuid, msgs, querySource)` 가 `compactMetadata` 에 `preservedSegment {headUuid, anchorUuid, tailUuid}` 와 `preservedMessages {anchorUuid, uuids[]}` 를 추가한다 — compaction-system.md §3.2 참조.

#### 2.1.2 UI 디스플레이 (확인)

`Ju7` (12757):
```js
function Ju7(){
  let _ = w1("app:toggleTranscript", "Global", "ctrl+o")
  return React.createElement(B, {marginY:1},
           React.createElement(V, {dimColor:!0},
             "✻ Conversation compacted (", _, " for history)"))
}
```

→ 메인 디스플레이는 `✻ Conversation compacted (ctrl+o for history)` 단 한 줄 — 사용자 키바인딩이 동적으로 삽입됨. `rq()` 가 true (=resume 모드 등) 면 렌더 안 함.

요약 메시지(`isCompactSummary:true`) 는 별도 `eC7` 컴포넌트로 transcript-only 펼침 가능 (메인뷰에선 접힘).

#### 2.1.3 호출 사이트 (Bq3 내부, line 14057)

autocompact 성공 직후 (확인):
```js
F = {compacted:!0, turnId:J.uuid(), turnCounter:0, consecutiveFailures:0, consecutiveRapidRefills:o}
let b_ = AKH(e)            // e = compactionResult
for (let B_ of b_) yield B_
x = b_                      // messages 자체를 평탄화 결과로 교체
```

reactive compact 성공 직후 (확인):
```js
// transition: precomputed_compact_swap | reactive_compact_retry
D = {messages: AKH(c_), ..., transition:{reason: p_?"precomputed_compact_swap":"reactive_compact_retry"}}
continue
```

즉 `flattenCompactionResult` 의 결과가 **그 자리에서 yield (autocompact)** 또는 **D.messages 교체 + continue (reactive)** 로 분기된다. autocompact 경로는 같은 턴 내에서 메시지를 교체하므로 `yield` 로 UI 에 흘리고; reactive 는 턴 자체를 재시작하므로 yield 없이 다음 진입에서 새로 yield 된다 — 확인.

`hookResults` 의 정체 (확인 — compaction-system.md §3.8): PreCompact / SessionStart / PostCompact 중 **SessionStart** hook 의 `additionalContext` 출력. PreCompact 는 `userDisplayMessage` 만 채우고, PostCompact 도 마찬가지 — 본격 message 들은 SessionStart 가 만든다. compaction-system.md 의 "PreCompact/PostCompact hook 출력 주입" 표현은 정확히는 SessionStart 재실행 결과 주입이다 — 확인.

---

### 2.2 `Uq3(messages) → turnStartIndex: number` [14058]

verbatim (확인):
```js
function Uq3(H){
  for(let _=H.length-1; _>=0; _--){
    let q = H[_]
    if(q.type==="user" && !q.isMeta && !q.toolUseResult && !q.isCompactSummary)
      return _
  }
  return 0
}
```

**판단 기준** (확인):
- `type === "user"` 만 대상 — assistant, system, attachment, progress 등은 모두 스킵.
- `!isMeta` — `D6({isMeta:true, ...})` 로 만든 메타 메시지 (예: max_output_tokens recovery 메시지, malformed tool_use retry 메시지) 는 제외.
- `!toolUseResult` — tool result 형태의 user 메시지는 제외 (실제 사용자 입력만).
- `!isCompactSummary` — `<summary>` 컨텐츠를 담은 가짜 user 메시지는 제외.

→ 효과적으로 **"마지막으로 사용자가 직접 입력한 prompt 의 인덱스"** 를 반환. Compact boundary 자체는 `type:"system"` 이므로 자동으로 스킵되지만, 그 다음에 오는 summaryMessages 가 `isCompactSummary:true` 이므로 스킵 → autocompact 직후의 첫 "진짜 user 메시지" 를 찾으려면 compact 결과로 교체된 messages 의 맨 뒤 (보존 영역) 에서 직전 user 가 발견됨.

**edge case**:
- 빈 배열 / 매칭 없음 → `return 0` (확인). 메시지 0번부터 turn 시작으로 처리.
- system prompt 만 있는 상태 → 모두 type≠"user" 이므로 0 반환 (확인).

**Bq3 내 사용 위치** (확인): `Z={...Z, messages:x, turnStartIndex:Uq3(x)}` — 매 turn 진입 후 메시지 정규화 + 컴팩션 처리 직후 `toolUseContext` 에 합치는 위치.

**소비자 측 사용** (확인):
- `im7(...)` (line 12884): `for (K = messages.length-1; K >= turnStartIndex; K--)` — `turnStartIndex` 까지 거꾸로 훑어서 슬래시 명령 / 메타 키워드를 탐지.
- ReplState 의 default `turnStartIndex:0` (20703, 17139) — 세션 초기화 시 0.

따라서 UI 의 "스크롤 to current turn start" 가설은 정확하지 않으며, **현재 turn 의 "사용자 입력 시작점"** 을 백워드 탐색의 컷오프로 쓴다 — 도구가 "이번 턴 안에서만" 자기 결과를 찾도록 제한할 때 사용 — 확인.

---

### 2.3 `zNH(tokens, model, autoCompactWindow) → { level, pctLeft? }` [14777]

verbatim (확인):
```js
function zNH(H,_,q){
  let K = gE8()                       // gate config
  let O = K.enabled ? q : void 0      // override window only if autocompact enabled
  return T_K(H, lHH(_, O), K, i13(_))
}
```

#### 2.3.1 `T_K` 본체 (level 결정) [14764]

verbatim (확인):
```js
function T_K(H, _, q, K=_){
  let O = BP_(_, q)                    // compact 임계 (effectiveWindow - 13000 또는 testPctOverride)
  let T = q.enabled ? O : _            // autocompact 활성: compact 임계 / 비활성: window 자체
  let $ = T - 20000                    // warn 임계: compact 임계 - 20k
  let z = q.testBlockingOverride
  let A = (z!==void 0 && !isNaN(z) && z>0)
            ? z
            : K - 3000                 // blocked 임계: rawContextLimit - 3000
  let Y = Math.max(0, Math.round((T-H)/T*100))   // pctLeft (compact 기준)
  if (H >= A) return { level:"blocked", pctLeft: Y }
  if (q.enabled && H >= O) return { level:"compact", pctLeft: Y }
  if (H >= $) return { level:"warn", pctLeft: Y }
  return { level:"ok" }
}
```

**4단계 enum** (확인): `"ok" | "warn" | "compact" | "blocked"`.
agent-loop.md 의 3단계 enum (`ok | warn | blocked`) 은 오기록 — 실제로는 4단계이며 `compact` 가 autocompact 트리거 레벨로 별도 존재 — 확인.

#### 2.3.2 임계값 산출 — `BP_`, `lHH`, `i13` [14762, 14770, 14771]

verbatim (확인):
```js
function BP_(H, _){
  let q = H - 13000                    // 기본: window - 13000
  let K = _.testPctOverride
  if (K!==void 0 && !isNaN(K) && K>0 && K<=100)
    return Math.min(Math.floor(H * (K/100)), q)
  return q
}
function lHH(H, _){
  let q = Math.min($KH(H), A_K)        // output reserve (모델별 max output, capped to A_K=20000)
  let K = r0() ? _ : void 0            // r0() = autoCompactEnabled
  let { window:O } = Kr(H, K)
  return O - q                          // effective window = configured - output reserve
}
function i13(H){
  let _ = Math.min($KH(H), A_K)
  return hP(H, fD()) - _                // raw model window - output reserve (autocompact 없이)
}
```

상수 (확인):
- `q_K = 13000` — compact 트리거 buffer
- `K_K = 3000` — blocked buffer (compact 와 blocked 사이의 마지막 안전판)
- `A_K = 20000` — output reservation 상한
- `uE8 = 0.2` — precomputeBufferFraction 기본 (gE8 에서 `r13()` 으로 읽음)

#### 2.3.3 4-tier 레벨 의미 (확인)

`H` 가 현재 토큰 카운트, `_` 가 `lHH(model, autoCompactWindow)` (autocompact 활성 시 윈도우), `K` 가 `i13(model)` (raw 윈도우):

| H 범위 | level | 의미 |
|---|---|---|
| `H >= K-3000` | `"blocked"` | raw 모델 한계의 3000 토큰 안쪽 — 더 이상 어떤 요청도 못 보냄 |
| autocompact ON, `H >= BP_(lHH, ...)` | `"compact"` | autocompact 트리거 — 이번 턴 압축 필요 |
| autocompact OFF, `H >= lHH-20000` | `"warn"` | (autocompact 꺼져 있으면 compact 없이 warn 로 직행) |
| autocompact ON, `H >= BP_-20000` | `"warn"` | compact 임계 20k 전 사전 경고 |
| 그 외 | `"ok"` | 정상 |

**env override** (확인):
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` — `testPctOverride` (compact 임계를 윈도우의 %)
- `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` — `testBlockingOverride` (blocked 임계 절대값)

#### 2.3.4 Bq3 의 blocking_limit 검사 (확인)

`runTurnLoop` line 14057 에서 (verbatim 패치):
```js
let kH = Nw_() && r0() && !oiH(Z.options.mainLoopModel, Z.getAutoCompactWindow())
if (!e /*compactionResult*/ && z!=="compact" && !kH && !GH) {
  if (zNH(Wf(x,rZ(Z.options.mainLoopModel)) - c, Z.options.mainLoopModel, Z.getAutoCompactWindow())
        .level === "blocked") {
    d("tengu_ptl_surfaced_to_user", {
      reason: "blocking_limit",
      querySource: dJ(z),
      wasGatedByPriorAttempt: !1
    })
    let H_ = y1({content:wg, error:"invalid_request", now:J.now, uuid:J.uuid})
    return yield H_, pJH(Z,z,H_), { reason:"blocking_limit" }
  }
}
```

조건 (확인):
- 이번 턴 autocompact 안 했음 (`!compactionResult`)
- 호출자가 `/compact` 명령으로 진입한 경우 아님 (`z !== "compact"`)
- reactive 가 충분히 활성 + 자동 윈도우 사용자 정의 아님 (`!kH`) — `kH` 가 true 면 reactive 가 PTL 시 처리하므로 미리 차단할 필요 없음
- `GH` 는 항상 `false` 로 초기화되어 있고 코드 흐름상 변경 없음 — 사실상 죽은 분기 (확인)

`zNH(...).level === "blocked"` 이면:
1. `tengu_ptl_surfaced_to_user` 텔레메트리 (`reason:"blocking_limit"`)
2. `y1({content: wg, error:"invalid_request"})` → ApiErrorMessage 메시지 빌드. **본문은 `wg = "Prompt is too long"`** — 추가 안내문 없음 (확인).
3. yield → `persistTurnFailure` (API failure 영속화) → `return { reason:"blocking_limit" }`

**중요**: agent-loop.md 의 추측 본문 ("Your message is too long even after auto-compaction. Start a new session...") 은 **틀렸다**. 실제로는 단순히 `"Prompt is too long"` 문자열 하나만 yield 된다 — 확인.

---

### 2.4 표준 에러 메시지 본문 (verbatim)

#### 2.4.1 `blockingLimitMsg` — PTL / blocking_limit 본문 [7944]

verbatim (확인):
```
"Prompt is too long"
```

용도 4종:
1. `runTurnLoop` 의 `blocking_limit` 진입 (위 2.3.4)
2. `OGH(msg)` 의 prefix 검사 — assistant 응답 본문이 `blockingLimitMsg` 로 시작하면 PTL 로 판정
3. callModel 의 `XH5` 에러 분류기 — 응답 메시지에 "prompt is too long" 포함 시 `y1({content:wg})` 빌드 (7939)
4. `xe_` 에러 분류기 — 메시지 lowercase 가 `wg.toLowerCase()` 포함하면 `"prompt_too_long"` 분류

#### 2.4.2 `rapidRefillBreakerMsg` — rapid_refill_breaker 본문 [14784]

verbatim (확인):
```
Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row. A file being read or a tool output is likely too large for the context window. Try reading in smaller chunks, or use /clear to start fresh.
```

(`UE8=3` 과 `oY6=3` 의 값이 템플릿 리터럴로 삽입 — 확인)

용도 2종:
1. `runTurnLoop` autocompact rapid_refill 경로 (line 14057 초반부)
2. `runTurnLoop` reactive compact 의 refill≥3 사전 차단 (compaction-system.md §1.2)

#### 2.4.3 max_output_tokens recovery meta — verbatim (확인)

`runTurnLoop` line 14057 내부:
```
Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.
```

(`—` 는 em dash `—`. 본문은 `D6({content: ..., isMeta:!0, ...})` 로 생성 — user role meta 메시지.)
주입 후 `D.messages = [...x, ...wH, b_]`, `transition: {reason:"max_output_tokens_recovery", attempt:L+1}`. `mq3=3` 회 초과 시 `yield T_` 로 원래 에러 메시지 surface — 확인.

#### 2.4.4 malformed tool_use retry meta — verbatim (확인)

`runTurnLoop` line 14057 내부:
```
Your tool call was malformed and could not be parsed. Please retry.
```

`D6({content: ..., isMeta:!0, ...})` 로 생성. `transition: {reason:"malformed_tool_use_retry"}`.
재시도 후에도 또 malformed 이면 별도 본문 (verbatim 확인):
```
The model's tool call could not be parsed (retry also failed).
```
이건 `y1({content: ...})` (ApiErrorMessage) 로 빌드되고 `{reason:"completed"}` 종료. `$NH(B_, Z)` (StopFailure hook) + `pJH(Z,z,B_)` 도 호출됨 — 확인.

#### 2.4.5 Stop hook cap 초과 본문 — verbatim (확인)

`runTurnLoop` line 14057, `B_` 가 `nextBlockCount`:
```
A hook blocked the turn from ending ${B_} consecutive times — overriding and ending turn. For Stop/SubagentStop hooks, check stop_hook_active in the input and return success while it's true. Set CLAUDE_CODE_STOP_HOOK_BLOCK_CAP to raise this limit.
```

`VO(text, "warning")` 로 빌드 (system informational message, level="warning"). yield 후 `{reason:"completed"}` 종료 (에러가 아님) — 확인.

기본 cap = 8 (env `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`). 0 이하면 cap 무시 — 확인.

#### 2.4.6 `JVH` — 인터럽트 메시지

`JVH` 는 source-level 정의가 분리되어 (extracted-functions.js 에서 destructure 형태로 직접 잡히지 않음), 사용처에서만 확인됨:
- `lz_ = new Set([hwH, cV, JVH, DVH, TGH])` (15613) — 특수 마커 5종을 모은 Set (모두 tool_result content 내부의 단축 표지자)
- `Ay8(toolUseId) = {type:"tool_result", content:JVH, is_error:!0, tool_use_id:H}` (15511) — interrupt-during-tool 시 합성하는 tool_result 본문
- `ru7` UI 컴포넌트 (12784): `q.content.startsWith(JVH)` 이면 `yu7` 렌더 (특정 인터럽트 컴포넌트로 분기)

**추정**: `JVH` 는 `"Interrupted by user"` 또는 유사 짧은 마커 문자열 — verbatim 확인 불가 (cstring rodata 의 별도 모듈에 있을 가능성). agent-loop.md 의 "interrupt during tool" 마커 역할은 정확.

#### 2.4.7 model fallback 알림 — verbatim (확인)

```
Switched to {fallbackModelName} due to high demand for {originalModelName}
```

(이름은 `nM(model)` 표시명 변환을 거침) — `VO(text, "warning")` 로 yield.

---

### 2.5 메시지 빌더 시그니처 (확인)

#### 2.5.1 `makeApiErrorMessage` — ApiErrorMessage 빌더 [15502]

verbatim:
```js
function y1({content:H, apiError:_, error:q, errorDetails:K, now:O, uuid:T}) {
  return B9K({
    content:[{type:"text", text: H==="" ? rv : H}],
    isApiErrorMessage:!0,
    apiError:_, error:q, errorDetails:K, now:O, uuid:T
  })
}
```

리턴 형상:
```ts
{
  type: "assistant",
  uuid: string,
  timestamp: ISO8601,
  message: {
    id: string,
    role: "assistant",
    model: jG,                           // "<api-error-model>" 표지
    type: "message",
    stop_reason: "stop_sequence",
    stop_sequence: "",
    stop_details: null,
    container: null,
    context_management: null,
    usage: { input_tokens:0, output_tokens:0, ... zero 채움 },
    content: [{type:"text", text}]
  },
  requestId: undefined,
  isApiErrorMessage: true,
  apiError?: string,
  error?: string,
  errorDetails?: string,
  isVirtual?: boolean
}
```

`rv` = empty content placeholder (확인 필요).
빌더 베이스 `makeMetaMessage` (15500) 가 공통 형상 — `hf` 는 isApiErrorMessage 없이 빌드, `makeApiErrorMessage` 은 항상 `isApiErrorMessage:!0`.

#### 2.5.2 `makeToolResultMessage` — UserMessage 빌더 [15503]

verbatim:
```js
function D6({
  content:H, isMeta:_, isVisibleInTranscriptOnly:q, isVirtual:K, isCompactSummary:O,
  summarizeMetadata:T, toolUseResult:$, mcpMeta:z, uuid:A, timestamp:Y,
  imagePasteIds:w, sourceToolAssistantUUID:j, permissionMode:J, origin:D,
  now:M, uuidFn:f
}) {
  return {
    type:"user",
    message:{ role:"user", content: H || rv },
    isMeta:_, isVisibleInTranscriptOnly:q, isVirtual:K, isCompactSummary:O,
    summarizeMetadata:T,
    uuid: A || (f?f():gL.randomUUID()),
    timestamp: Y ?? (M?M():new Date().toISOString()),
    toolUseResult:$, mcpMeta:z,
    imagePasteIds:w, sourceToolAssistantUUID:j,
    permissionMode:J, origin:D
  }
}
```

Bq3 내부 호출 패턴 3종 (확인):
- max_output_tokens recovery meta: `D6({content:"Output token limit hit. ...", isMeta:!0, now, uuidFn})`
- malformed tool_use retry meta: `D6({content:"Your tool call was malformed ...", isMeta:!0, now, uuidFn})`
- (reactive 경로의 추가 사용 — `JVH` 와 함께 tool_result 메시지 합성 등)

#### 2.5.3 `makeAttachmentMessage` — AttachmentMessage 빌더 [14331]

verbatim:
```js
function T9(H){return{attachment:H, type:"attachment", uuid:yt7.randomUUID(), timestamp:new Date().toISOString()}}
```

Bq3 내 사용:
- `T9({type:"max_turns_reached", maxTurns:Y, turnCount:b_})` — max turns 도달 시
- `T9({type:"hook_additional_context", content, hookName, toolUseID, hookEvent})` — hook 결과 (다른 곳)

#### 2.5.4 `makeNotification` — System informational message 빌더 [15579]

verbatim:
```js
function VO(H,_,q,K){
  return {
    type:"system",
    subtype:"informational",
    content: H,
    isMeta:!1,
    timestamp: new Date().toISOString(),
    uuid: gL.randomUUID(),
    toolUseID: q,
    level: _,                           // "info" | "warning" | "error"
    ...(K && {preventContinuation: K})
  }
}
```

Bq3 내 사용:
- Stop hook cap 초과 경고: `VO("A hook blocked the turn...", "warning")`
- model fallback 알림: `VO("Switched to ${fb} due to high demand for ${orig}", "warning")`

`preventContinuation:true` 는 보통 stop_hook_prevented 경로용 (확인 필요).

#### 2.5.5 `makeMetaMessage` — assistant base 빌더 [15500]

`hf` / `makeApiErrorMessage` 둘의 베이스. `usage` 의 모든 필드를 0 으로 채우는 것이 특징 (token 추정기가 ApiErrorMessage 를 token cost 0 으로 계산하도록).

---

### 2.6 `persistTurnFailure` / `abortCleanup` / `runStopFailureHook` — turn 종료 시 영속화/hook 호출

#### 2.6.1 `mJH(toolUseContext, querySource)` [14051]

verbatim:
```js
function mJH(H,_){
  let q = riH()
  if (!u4H || !q || !G7() || !_.startsWith("repl_main_thread") || H.agentId) return
  u4H().markTurnAborted(q, x0())
}
```

조건 (확인): main REPL session (`repl_main_thread*`) + 인증 OK + subagent 아님. 충족 시 `u4H().markTurnAborted(sessionId, replId)`.

Bq3 호출 위치 (확인):
- `aborted_streaming` 종료 직전
- `aborted_tools` 종료 직전
- `tool_deferred` 종료 직전
- `hook_stopped` 종료 직전
- ScheduleWakeup dynamic loop 종료 직전

→ 즉 **모델 호출은 정상이었지만 사용자/도구가 인터럽트한** 경로에만 호출. 모델 오류 (`prompt_too_long` / `image_error` / `blocking_limit` / `model_error` / `rapid_refill_breaker` / `completed`) 에는 `persistTurnFailure` 가 호출됨 (대비).

#### 2.6.2 `pJH(toolUseContext, querySource, errMsg)` [14052]

verbatim:
```js
function pJH(H,_,q){
  let K = riH()
  if (!u4H || !K || !G7() || !_.startsWith("repl_main_thread") || H.agentId) return
  u4H().markApiFailure(K, x0(), q.error, rE(q) ?? q.errorDetails ?? "").catch(()=>{})
}
```

조건은 `abortCleanup` 와 동일. 추가로 `q.error` (예: `"invalid_request"`, `"rate_limit"` 등 — y1 의 `error` 필드) 와 텍스트 본문 (`rE(q)` 가 첫 text block 텍스트 추출) 을 함께 영속화.

Bq3 호출 위치 (확인):
- `rapid_refill_breaker` 종료 직전
- `blocking_limit` 종료 직전
- `image_error` / `prompt_too_long` 종료 직전 (`reason:WH`)
- 최종 malformed retry 실패 시
- last 가 `isApiErrorMessage` 인 일반 `completed` 종료 직전

#### 2.6.3 `$NH(errMsg, toolUseContext)` — **StopFailure hook 실행기**

[18831 부근, `bp3.StopFailure = $NH`]. 즉 **29 hook event 중 하나** 인 `StopFailure` 의 executor — hook-system.md 의 일부.

호출 의미: **API 실패로 턴이 끝나려는 시점에 사용자 정의 StopFailure hook 들을 실행** — 사용자가 실패 알림을 받거나 자동 재시작 hook 을 등록할 수 있게 함.

Bq3 호출 위치 (확인):
- `rapid_refill_breaker` 종료 직전 (gy8 에러 yield 직후) — **호출 안 됨** (pJH 만)
- `blocking_limit` 종료 — **호출 안 됨** (pJH 만)
- `prompt_too_long` / `image_error` 종료 직전 (verbatim: `return yield T_, $NH(T_,Z), pJH(Z,z,T_), {reason:WH}`)
- 최종 malformed retry 실패 시 (`return yield B_, $NH(B_,Z), pJH(Z,z,B_), {reason:"completed"}`)
- last 가 `isApiErrorMessage` 인 일반 `completed` 종료 (verbatim: `return $NH(T_,Z), pJH(Z,z,T_), {reason:"completed"}`)

→ **rapid_refill_breaker / blocking_limit 은 $NH 를 거치지 않는다** (이미 직접 만든 합성 에러이므로 hook 으로 전파할 의미가 없음). 진짜 모델 응답이 에러일 때만 StopFailure hook 발동 — 확인.

---

### 2.7 `v5("query_*")` 성능 마커 — Bq3 내 13개 (확인)

`v5(name)` 은 OpenTelemetry / 내부 프로파일러용 한 줄 마커 (시작/종료를 다른 호출로 페어링). Bq3 line 14057 안에서 `v5(` 호출이 정확히 13개:

| # | 마커 | 호출 위치 / 의미 |
|---|---|---|
| 1 | `query_fn_entry` | 함수 진입 (`stream_request_start` yield 직후) |
| 2 | `query_microcompact_start` | tier 1 microcompact (`microcompactNoop`) 호출 직전 |
| 3 | `query_microcompact_end` | microcompact 호출 직후 |
| 4 | `query_autocompact_start` | tier 2 autocompact (`runAutocompact`) yield* 직전 |
| 5 | `query_autocompact_end` | autocompact yield* 직후 |
| 6 | `query_setup_start` | gX_ streaming exec 컨테이너 + 시스템 prompt 등 셋업 시작 |
| 7 | `query_setup_end` | 셋업 끝, blocking_limit 검사 직전 |
| 8 | `query_api_loop_start` | inner-while (model fallback retry 루프) 진입 직전 |
| 9 | `query_api_streaming_start` | callModel for-await 진입 직전 |
| 10 | `query_api_streaming_end` | callModel for-await 종료 직후 |
| 11 | `query_tool_execution_start` | tool batch 실행 (`dispatchToolBatch` 또는 `TH.getRemainingResults`) 직전 |
| 12 | `query_tool_execution_end` | tool batch 끝 |
| 13 | `query_recursive_call` | 다음 턴 `D = {...}` 직전 (`continue` 직전, 즉 자연 next_turn) |

추가 비-Bq3 (call-model.md 등 별도 모듈) 에는 `query_api_request_sent`, `query_response_headers_received` 가 있을 가능성 — Bq3 본문에는 **없음**.

특이점:
- `query_setup_start` 와 `query_setup_end` 사이에 `StreamingToolExecutor` 생성 + `iZ()` 모델 swap + `appState` / `permissionMode` 추출이 들어감.
- `query_api_loop_start` 는 fallback retry 가 가능한 outer-loop 의 진입점이지만 마커 자체는 단 1회 발행 (각 retry 마다 발행 아님).
- `query_recursive_call` 만 **정상 next_turn 경로에서만** 마커가 박힘 — 다른 분기 (retry/recovery) 는 별도 마커 없음.
- agent-loop.md 의 요청서 14개 중 `query_api_request_sent` / `query_response_headers_received` 는 **Bq3 본문에 없음** — callModel 내부 마커일 것 (call-model.md 모듈 확인 필요).

---

## 3. State / Schema

### 3.1 `compactionResult` 입력 shape — `flattenCompactionResult` 가 받는 객체

`compactionResult` 는 autocompact (`autocompactImpl`) 와 reactive (`a47`) 가 동일 형상으로 생성:

```ts
type CompactionResult = {
  boundaryMarker: SystemMessage          // type:"system", subtype:"compact_boundary"
  summaryMessages: UserMessage[]         // isCompactSummary:true 인 user msg(s)
  messagesToKeep: AssistantMessage[]     // bw5() 로 usage 0 마스킹된 보존 메시지
  attachments: (UserMessage|AttachmentMessage)[]   // 재투입된 todos/plan/skills/file
  hookResults: (UserMessage|AttachmentMessage)[]   // SessionStart hook 결과
  userDisplayMessage?: string            // PreCompact + PostCompact 합산 표시문 (UI용)
  preCompactTokenCount: number
  postCompactTokenCount: number
  truePostCompactTokenCount: number
  compactionUsage: Usage                 // {input_tokens, output_tokens, cache_*, ...}
  // 추가 (autocompact 만):
  trigger?: "auto" | "manual"            // 진입 querySource 기반
}
```

`flattenCompactionResult` 는 이 중 5개 필드만 사용 (boundaryMarker + summaryMessages + messagesToKeep + attachments + hookResults). 나머지는 텔레메트리 / UI 표시용 — 확인.

### 3.2 `contextPressureLevel` return shape

```ts
type ContextPressureLevel = "ok" | "warn" | "compact" | "blocked"
type ZnhResult =
  | { level: "ok" }
  | { level: "warn",    pctLeft: number }   // 0-100
  | { level: "compact", pctLeft: number }
  | { level: "blocked", pctLeft: number }
```

`pctLeft` 는 compact 임계 기준의 남은 % (즉 compact 임계까지 얼마 남았는지). `ok` 만 pctLeft 가 없음 — 확인.

### 3.3 `blockingLimitMsg` / `rapidRefillBreakerMsg` / 메타 메시지 위치 카탈로그

| 식별자 | 위치 | 본문 |
|---|---|---|
| `blockingLimitMsg` | extracted-functions.js:7944 (const) | `"Prompt is too long"` |
| `rapidRefillBreakerMsg` | extracted-functions.js:14784 (const) | `"Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row. A file being read or a tool output is likely too large for the context window. Try reading in smaller chunks, or use /clear to start fresh."` |
| max_output_tokens recovery | Bq3 inline literal (line 14057) | `"Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces."` |
| malformed tool_use retry | Bq3 inline literal (line 14057) | `"Your tool call was malformed and could not be parsed. Please retry."` |
| malformed retry 실패 | Bq3 inline literal (line 14057) | `"The model's tool call could not be parsed (retry also failed)."` |
| Stop hook cap | Bq3 inline literal (line 14057, `VO(...,"warning")`) | `"A hook blocked the turn from ending ${N} consecutive times — overriding and ending turn. For Stop/SubagentStop hooks, check stop_hook_active in the input and return success while it's true. Set CLAUDE_CODE_STOP_HOOK_BLOCK_CAP to raise this limit."` |
| model fallback | Bq3 inline literal | `"Switched to ${nM(fb)} due to high demand for ${nM(orig)}"` |
| `JVH` | source 위치 미해석 (추정 — Interrupted by user) | `Ay8(toolUseId)` 의 tool_result content + UI `yu7` 컴포넌트 분기 |

### 3.4 Bq3 의 `transition.reason` ↔ 종료 reason ↔ 호출되는 후처리 함수 매트릭스

| transition / 종료 | mJH | pJH | $NH (StopFailure) | yield 본문 |
|---|---|---|---|---|
| `rapid_refill_breaker` (return) | — | ✓ | — | `rapidRefillBreakerMsg` |
| `blocking_limit` (return) | — | ✓ | — | `blockingLimitMsg` |
| `prompt_too_long` / `image_error` (return) | — | ✓ | ✓ | 실제 응답 last |
| `model_error` (return) | — | (outer catch) | — | 변환된 에러 |
| `image_error` (mUH/iF 예외 경로) | — | (outer catch) | — | exception 메시지 |
| `aborted_streaming` / `aborted_tools` (return) | ✓ | — | — | (이미 yield된 partial) |
| `tool_deferred` / `hook_stopped` (return) | ✓ | — | — | — |
| `completed` (malformed 실패) | — | ✓ | ✓ | 새 ApiError 합성 |
| `completed` (last 가 isApiErrorMessage) | — | ✓ | ✓ | (이미 yield된 last) |
| `completed` (Stop cap) | — | — | — | `VO(stop-cap 메시지, "warning")` |
| `completed` (정상) | — | — | — | — |
| `completed` (loop dynamic wakeup) | ✓ | — | — | `ka7` 의 yield* |
| `stop_hook_prevented` (return) | — | — | — | — |
| `max_turns` (return) | — | — | — | `T9({type:"max_turns_reached"})` |
| `max_output_tokens_recovery` (continue) | — | — | — | meta msg |
| `malformed_tool_use_retry` (continue) | — | — | — | meta msg |
| `reactive_compact_retry` (continue) | — | — | — | (다음 턴에서 AKH yield) |
| `precomputed_compact_swap` (continue) | — | — | — | (다음 턴에서 AKH yield) |
| `stop_hook_blocking` (continue) | — | — | — | (blockingErrors 가 새 messages 에 합쳐짐) |
| `next_turn` (continue) | — | — | — | — |

---

## 4. 차이점 / 보강 (v0.2.8 대비 — agent-loop.md / compaction-system.md 와 겹치지 않는 부분만)

### 4.1 평탄화 함수의 단순함

`flattenCompactionResult` 는 **1줄짜리 평탄화 함수**. v0.2.8 는 별도 평탄화 없이 `/compact` 가 `messages = [{role:"user", content:summary}]` 로 직접 교체 (compaction-system.md §2.1 의 SDK `sdkCompactionCheck` 와 동일). v2.1.143 는 5종 영역을 명시적으로 분리한 결과를 **재투입 (attachments + hookResults)** 까지 포함해 한 번에 평탄화 — 단순히 요약 교체가 아닌 **세션 상태 회복** 이 목적.

### 4.2 `lastTurnBoundaryIndex` 의 부재 = v0.2.8

v0.2.8 의 `query()` 는 재귀로 호출되어 호출 스택이 곧 turn boundary 이므로 별도 인덱스가 필요 없었다. v2.1.143 는 단일 `while` + 메시지 누적 모델이므로 "현재 turn 의 시작점" 을 메시지 배열 위에서 계산해야 함 → `lastTurnBoundaryIndex` 신설.

### 4.3 `contextPressureLevel` 의 4단계 enum

v0.2.8 는 단순 "token > X" boolean 체크. v2.1.143 는 4-tier (`ok`/`warn`/`compact`/`blocked`) + env override + autocompact 활성 여부에 따른 임계 동적 계산. `blocked` 는 reactive 도 못 도와줄 사이즈일 때만 발동 — autocompact 가 켜져 있으면 `compact` 단계에서 자동 보호되므로 `blocked` 는 실질적으로 fallback model 도 못 쓰는 극단 케이스만.

### 4.4 메타 메시지 (`isMeta:true`) 의 역할

v2.1.143 신규: max_output_tokens recovery / malformed retry / Stop block error 가 **user role + isMeta:true** 메시지로 들어감 → `lastTurnBoundaryIndex` 의 boundary 탐색에서 자동 스킵되어 "진짜 사용자 입력" 위치가 보존됨. v0.2.8 에는 이런 자동 메타 주입이 없었음.

### 4.5 `persistTurnFailure` / `abortCleanup` / `runStopFailureHook` 분리

세 함수가 서로 다른 의미를 명확히 분리 (turn aborted vs API failure vs StopFailure hook). v0.2.8 는 통합 `markFailed` 류 하나. v2.1.143 는 abort 경로(사용자 의도) vs 에러 경로(모델/시스템 실패) vs hook 통지를 모두 분리해서 텔레메트리 / UI 가 정확한 원인 표시 가능.

---

## 부록: 정확한 호출 위치 인덱스

| 식별자 | 라인 | 정의 |
|---|---|---|
| `flattenCompactionResult` | 14736 | compactionResult → Message[5종 concat] |
| `lastTurnBoundaryIndex` | 14058 | turnStartIndex (마지막 진짜 user msg index) |
| `contextPressureLevel` | 14777 | level 결정 entry |
| `T_K` | 14764 | level 결정 본체 (4-tier) |
| `BP_` | 14762 | compact 임계 계산 |
| `lHH` | 14770 | effective window |
| `i13` | 14771 | raw model window - output reserve |
| `gE8` | 14775 | gate config 통합 (env override 포함) |
| `blockingLimitMsg` | 7944 (const) | `"Prompt is too long"` |
| `rapidRefillBreakerMsg` | 14784 (const) | rapid_refill_breaker 본문 |
| `vw_` | 15589 | compact_boundary 마커 빌더 |
| `Ju7` | 12757 | compact_boundary UI 컴포넌트 |
| `makeApiErrorMessage` | 15502 | ApiErrorMessage 빌더 |
| `makeToolResultMessage` | 15503 | UserMessage 빌더 |
| `makeAttachmentMessage` | 14331 | AttachmentMessage 빌더 |
| `makeNotification` | 15579 | System informational message 빌더 |
| `makeMetaMessage` | 15500 | Assistant base 빌더 |
| `abortCleanup` | 14051 | turn aborted 마킹 |
| `persistTurnFailure` | 14052 | API failure 영속화 |
| `runStopFailureHook` | 18831 (bp3 매핑) | StopFailure hook executor |
| `predicateMaxOutputTokens` | 14053 | `apiError === "max_output_tokens"` predicate |
| `predicateApiError` | 9891 | PTL assistant 검사 |
| `predicateImageError` | 9892 | image error assistant 검사 |
| `predicatePromptTooLong` | 7913 | isPromptTooLongError (wg prefix 검사) |
| `bw5` | 9900 | usage 0 마스킹 |
| `Hr_` | 5755 | (현재 항상 `false` 반환 — loop dynamic 진입 비활성?) |
| `az` | 8328 | `"ScheduleWakeup"` (cron 도구명) |
| `mq3` | 14058 (const) | `3` — max_output_tokens recovery 한계 |
| `q_K` | 14764 | `13000` — compact buffer |
| `K_K` | 14764 | `3000` — blocked buffer |
| `A_K` | 14764 | `20000` — output reservation cap |
