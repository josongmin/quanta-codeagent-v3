# Compaction 시스템 (3-tier + reactive + breaker)

추출 위치: `extracted-functions.js`

v2.1.143은 **세 가지 독립 계층**의 compaction을 가지며, 그 위에 **반응형(reactive)** 경로와 **breaker**가 얹혀 있다. v0.2.8은 `/compact` 슬래시 커맨드뿐이었다.

```
┌─ SDK BetaToolRunner (외부 SDK 사용자용)             qHq  (oH_ 클래스 내부)
│   └─ contextTokens >= HHq=1e5 ⇒ summarize ⇒ messages 전면 교체
│
└─ CLI 메인 루프 (Bq3)
    ├─ 매 턴 1단계  microcompact            J.microcompact = pt   (실제 no-op)
    ├─ 매 턴 2단계  autocompact             J.autocompact  = Ia7  → $rH  (yield* rY6)
    └─ PTL/이미지 에러 시  reactive compact  u47 (phase A) + o47 (phase B), rY6 wrap
        └─ b47() 가 "다음 턴부터 미리 만들어둘 것" 결정 ⇒ x47() 가 background precompute
        └─ rapid-refill breaker: Qy8() ≥ oY6=3 이면 gy8 에러로 종료
```

---

## 1. 호출 그래프

### 1.1. SDK 계층 — `oH_.qHq`

`extracted-functions.js:1942` — `BetaToolRunner` 클래스의 `sdkCompactionCheck` 프라이빗 메서드.
SDK 호출자가 `compactionControl: {enabled, contextTokenThreshold?, model?, summaryPrompt?}`를 전달하면 매 iteration 후 동작.

생성자에 deprecation 경고 (확인):
```
'Anthropic: The `compactionControl` parameter is deprecated and will be removed
 in a future version. Use server-side compaction instead by passing
 `edits: [{ type: "compact_20260112" }]` in the params passed to `toolRunner()`.
 See https://platform.claude.com/docs/en/build-with-claude/compaction'
```

→ Anthropic 서버측 compaction (`compact_20260112` edit)이 정답이고 SDK 클라이언트측 `compactionControl` 은 레거시. (CLI는 두 경로 모두 미사용 — 자체 compaction 사용)

### 1.2. CLI 메인 루프 (`runTurnLoop`) 통합 지점

`extracted-functions.js:14057` — turn loop. 매 턴 처음 부분:

```
v5("query_microcompact_start")
x = (await J.microcompact(x, Z, z)).messages       // 1단계
v5("query_microcompact_end")
qH = H4(ca7(q, O))                                  // system prompts 어셈블
v5("query_autocompact_start")
{compactionResult, consecutiveFailures, consecutiveRapidRefills, rapidRefillBreakerTripped}
    = yield* J.autocompact(x, Z, {...}, z, F, c)    // 2단계
v5("query_autocompact_end")
if (rapidRefillBreakerTripped) ⇒ return gy8 에러
if (compactionResult) ⇒ tengu_auto_compact_succeeded + F = {compacted:true, turnId, turnCounter:0, ...}
if (b47({...})) ⇒ x47({...})                        // 다음 턴용 precompute fork
```

그리고 API 호출 후 응답이 PTL 또는 image-too-large면:

```
if (!t /* no tool calls */) {
  const T_ = wH.at(-1)
  const H_ = T_?.type==="assistant" && T_.isApiErrorMessage && OGH(T_)   // PTL?
  const M_ = !(... isToolUseDeniedMessage) && rD8(T_)                    // image error?
  if (H_ || M_) {
    if (!k && Qy8(F) >= oY6) ⇒ rapid_refill_breaker (gy8 에러 종료)

    {swap, emittedEarlyCompactStart} = yield* rY6(__ => u47({
      toolUseContext: __, messages: x,
      isWithheld413: H_, hasAttemptedReactiveCompact: k,
      borrowFrom: g ? Z.precomputeSourceKey : undefined,
      ptlDetectedAt: B_, querySource: z
    }), Z)

    c_ = yield* rY6(__ => o47({
      hasAttempted: k, querySource: z, aborted, messages: x,
      cacheSafeParams: {...},
      precomputed: p_, userWaitStartedAt: B_, initialTokenGap: l_
    }), Z)

    if (c_) {  // 성공 — 메시지 교체 후 같은 턴 재시도
      F = {compacted:true, turnId, turnCounter:0, consecutiveFailures:0, consecutiveRapidRefills:b_}
      D.transition.reason = p_ ? "precomputed_compact_swap" : "reactive_compact_retry"
      continue
    }
  }
}
```

### 1.3. 1단계 — `microcompact` (`microcompactNoop`)

`extracted-functions.js:8419`:
```js
async function pt(H,_,q){ return ji9(), {messages: H} }
```

**확인**: 매 턴 호출되지만 실제로는 `kz_` state flag (`ji9` = `kz_.setState(()=>!1)`)만 끄고 **메시지를 그대로 반환**한다. 즉 v2.1.143 시점의 in-band microcompact는 사실상 hook용 자리 표시 — 실제 microcompact 로직은 별도 경로 두 곳에 분리되어 있음:

1. **time-based / context-hint trigger**: `timeBasedMicrocompact` (8424) — `iz8`/`replaceClearedHints` 사용해 오래된 tool_result content를 `"[Old tool result content cleared]"` (`clearedHintPlaceholder`) 로 치환. `tengu_time_based_microcompact` 이벤트.
   - threshold: `nz8 = 20000` 토큰 (이만큼 절약 가능할 때만 실행)
   - `_q5` (대상 도구): `Read` + 검색/list류 + Edit/Write
   - keepRecent: 최근 N개의 tool_use는 유지
   - `TSK` (19024)에서 `context_hint` 응답으로 호출
2. **callModel 내 `onHintCleared` 콜백** — API 측 `context-hint` 베타 헤더(`Ci6`)가 만든 클리어 지시를 `Nz_(x, b_, B_)`로 적용 (Bq3 14057)

즉 진짜 microcompact는 **서버측 context-hint** + **TSK 함수** 둘 다이고, `Sa7().microcompact = pt`는 (추정) 향후 확장용 hook 슬롯.

### 1.4. 2단계 — `autocompact` (`runAutocompact` ⇒ `autocompactImpl`)

`extracted-functions.js:14782` (`runAutocompact`):

1. `DISABLE_COMPACT` 환경변수면 skip
2. 직전 실패 횟수 ≥ `z_K = 3` (회로 차단)이면 skip
3. `o13(...)` 가 false면 skip — autocompact 트리거 판정
   - `K === "compact"` (수동 `/compact` 호출 중)이면 false
   - `r0()` (Statsig `autoCompactEnabled`)가 false면 skip
   - `Wf(H) - O` 가 `zNH(...).level === "compact" | "blocked"` 일 때만 true
4. `Qy8(O) >= oY6=3` (rapid refill breaker) 이면 abort with `{rapidRefillBreakerTripped:true}`
5. `yield* rY6((Z) => $rH(H, Z, q, true /*isAuto*/, ...))` — phase wrapper로 진짜 compaction 실행

#### `autocompactImpl` (14741) — 실제 summarize 작업
- 단계
  1. `lg({trigger:"auto"|"manual", customInstructions})` ⇒ PreCompact hook 실행 (29 hooks 중 하나). 결과로 `userDisplayMessage`, `newCustomInstructions` 받음.
  2. PreCompact 결과로 `blocked` 면 abort (확인 — `jj6` 안에서).
  3. `aq6(O)` 로 summary 요청 메시지 구성 — **`aq6`의 본문은 추출 JS 밖**(별도 module의 cstring; 확인 필요). 부근 함수 `V47` 에 보이는 강제 메시지: `"CRITICAL: Respond with TEXT ONLY. Do NOT call any tools."` + `"an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task."` — 추정컨대 summary 프롬프트는 `<analysis>` + `<summary>` 형식.
  4. `__K({messages, summaryRequest, ...})` 실행 — `tengu_compact_cache_prefix` 게이트 켜져 있으면 prompt-cache-sharing 경로(`speculativeExecEngine`)로 먼저 시도, 실패하면 일반 `NiH` (callModel) 스트리밍.
  5. PTL 응답(`blockingLimitMsg` 시작)이면 `tHK(G, k)` 로 메시지 앞쪽 일부 잘라내고 재시도. 최대 `sHK` 회.
  6. 성공 시 `vw_(trigger, preTokens, lastUuid)` — `{type:"system", subtype:"compact_boundary", ..., compactMetadata:{trigger, preTokens, ...}}` boundary 마커 생성. `Rw_(summaryText, ...)` 로 요약 컨텐츠 user 메시지 만듦.
  7. 시스템 reload: `readFileState.clear()`, attachments 재구성 (`A96`, `J96`, `Y96`, `j96`, `w96` — todo list / plan / skills / agentInstruction 등 재투입), Tool descriptions 재투입 (`XwH`, `BQH`, `UQH`), SessionStart hooks `um("compact",...)` 호출.
  8. PostCompact hook `PwH({trigger, compactSummary})` ⇒ `userDisplayMessage` 받음.
  9. `aD8(M, lastUuid, X, q)` 로 boundary 마커에 `preservedSegment{headUuid, anchorUuid, tailUuid}` + `preservedMessages{anchorUuid, uuids}` 추가.

#### 결과 (`compactionResult`)
```
{
  boundaryMarker,                  // type:"system", subtype:"compact_boundary"
  summaryMessages,                 // [user msg with <summary> 내용]
  messagesToKeep,                  // 끝부분 보존된 messages
  attachments,                     // 재투입된 todo / plan / skill / file attachments
  hookResults,                     // SessionStart 결과
  userDisplayMessage,              // PreCompact + PostCompact가 만든 표시 메시지
  preCompactTokenCount,
  postCompactTokenCount,
  truePostCompactTokenCount,
  compactionUsage,                 // {input_tokens, output_tokens, cache_*, ...}
}
```
`AKH(result)` 가 `[boundaryMarker, ...summaryMessages, ...messagesToKeep, ...attachments, ...hookResults]` 로 평탄화.

### 1.5. Reactive compact — `reactiveCompactPhaseA` (phase A) + `reactiveCompactPhaseB` (phase B) + `compactProgressQueue` wrap

#### `reactiveCompactPhaseA` (9883) — "borrow precomputed" 시도
입력: `{toolUseContext, messages, isWithheld413, hasAttemptedReactiveCompact, borrowFrom?, ptlDetectedAt, querySource}`

```
1. !(isWithheld413 && !hasAttemptedReactiveCompact && uD8())  ⇒ {swap:undefined, emittedEarlyCompactStart:false}
   // uD8() = Statsig "tengu_sepia_moth" — reactive 활성 게이트
2. precomputeSource (borrowFrom 우선, 없으면 자기 agent 키) status 가 "pending" 이면
   onCompactEvent({type:"compact_progress", event:{type:"compact_start"}})  // 사용자에 "compacting" UI 표시
   onCompactEvent({type:"sdk_status", status:"compacting"})
3. borrowFrom 가 있으면 Pw5(borrowFrom, signal) 로 빌려옴 (await 가능)
4. 그래도 없으면 자기 agent의 Ww5(agentId, signal) — pending이면 settle 대기
5. precompute 가 ready 이고 messages 의 precomputedAtUuid 이후 부분(Zw5)이 추적 가능하면
   swap = {compactResult, preCompactHookDisplay, messagesSince, statusAtPTL, leadMs, totalMs, borrowed}
```
즉 **precomputed compact를 PTL 시점에 "swap in"** 하는 빠른 경로. 백그라운드에서 미리 만들어둔 요약을 그대로 끼워 넣는다.

#### `reactiveCompactPhaseB` (9894) — "wait + summarize" (precompute 실패 시 동기 경로)
입력: `{hasAttempted, querySource, aborted, messages, cacheSafeParams, precomputed?, userWaitStartedAt, initialTokenGap}`

```
1. !(!hasAttempted && querySource!=="compact" && r0() && !aborted && Nw_())  ⇒ null
   // Nw_() = Statsig "tengu_cobalt_raccoon" — reactive 메인 게이트
2. tengu_reactive_compact_triggered 텔레메트리
3. summary state 강제: yQH(getToolPermissionContext(), "summary")
4. precomputed 가 있으면 ⇒ a47() 로 보관된 결과를 즉시 결합
   precomputed 가 없으면 ⇒
     onCompactEvent({type:"compact_progress", event:{type:"hooks_start", hookType:"pre_compact"}})
     onCompactEvent({type:"sdk_status", status:"compacting"})
     PreCompact hook lg({trigger:"auto", customInstructions:null}) 실행
     oD8(messages, cacheSafeParams, {customInstructions, userWaitStartedAt, querySource, initialTokenGap, trigger:"auto"})
       ⇒ tq6(messages, cacheSafeParams, {customInstructions, initialTokenGap})
5. PreCompact 가 blockedBy 면 ⇒ null (compact 중단)
6. summarize().catch(error) ⇒ failed metric + null
7. 성공 시 boundaryMarker 토큰 카운트 갱신, sn() 으로 PostCompact 외 정리
```

#### `tq6` (9857) — reactive 의 실제 요약 구현 (autocompact 의 `autocompactImpl` 와 다르다)
- 메시지를 `SQH(K)` 로 **assistant id 단위 그룹**으로 쪼갬 (`O` 그룹들)
- `T < 2` (그룹 < 2개) ⇒ `{ok:false, reason:"too_few_groups"}`
- 시작 시 `initialTokenGap` 가 있으면 — `N47(w, T-1, gap)` 로 "토큰 갭만큼 거꾸로 누적" 해서 step 결정. `seeded` mode.
- 루프:
  1. `J = T - z` (요약할 prefix 길이), `D = O.slice(0,J)`, `M = O.slice(J)` (보존)
  2. `f` 에 assistant 메시지가 하나도 없으면 ⇒ `{ok:false, reason:"too_few_groups"}`
  3. `Dw5(f, _, customInstructions, strippedMedia)` 호출 → 요약 모델 호출
  4. 결과별 분기:
     - `ok` ⇒ 결과 반환 `{ok:true, result:{summaryMessages, summaryText, messagesToPreserve, attempt, totalUsage, groupsPreserved, totalGroups}}`
     - `media_too_large` 이고 첫 시도면 ⇒ `strippedMedia=true` 후 재시도
     - `media_too_large` 이고 두 번째면 ⇒ `{ok:false, reason:"media_unstrippable"}`
     - `prompt_too_long` ⇒ `Mw5(tokenGap, w, J)` 로 다음 step 계산하여 `z` 증가 (더 많이 보존 → 적게 요약)
     - `aborted` / `error` ⇒ 즉시 반환
- 모두 실패 시 `{ok:false, reason:"exhausted"}`

#### `Dw5` (9853) — 단일 요약 시도
`PL({promptMessages:[T], cacheSafeParams, ..., querySource:"compact", forkLabel:"reactive-compact", maxTurns:1, maxOutputTokens:min(B5_, max), skipTranscript:true, skipCacheWrite:true})` 로 **fork된 query** 실행. `aq6(customInstructions)` 가 만든 메시지가 prompt. 응답이 PTL이면 `tokenGap = FUH(z)` 으로 캘리브레이션.

#### `a47` (9899) — 요약 후 후처리 (precomputed/online 공용)
- `readFileState.clear()`, 메모리 selector reset
- attachments + hooks 재투입 (`xw5` 안에서 `A96/J96/Y96/j96/w96` + `XwH/BQH/UQH` + `um("compact",...)`)
- PostCompact hook `PwH({trigger, compactSummary})`
- `aD8(...)` 로 boundaryMarker 에 preservedSegment 메타 추가
- `tengu_reactive_compact_succeeded` 텔레메트리 발행 (input/output/cache 토큰 분리)

### 1.6. `compactProgressQueue` (14784) — yield wrapper

```js
async function*rY6(H, _){
  let q = new Pn  // 큐
  let K = {..._,
    onCompactEvent: (T) => q.enqueue(T),
    resetResponseLength: () => q.enqueue({type:"response_length", op:"reset"}),
    addResponseLength: (T) => q.enqueue({type:"response_length", op:"add", delta:T}),
    addNotification: (T) => { ... }
  }
  let O
  H(K).then((T)=>{ O = T; q.done() }, (T)=>q.error(T))
  yield* q
  return O
}
```

→ compaction 내부에서 발생하는 `compact_progress`/`sdk_status`/`stream_mode`/`response_length` 이벤트를 외부 generator 로 흘려보내면서 결과는 별도로 await. **압축 과정이 UI에 실시간 진행 표시** 가능하게 만드는 핵심.

### 1.7. Precompute fork — `startPrecomputeFork` (9875)

`b47({...})` (9874) 가 다음 조건 모두 만족 시 true:
- `compactionResult === undefined` (이번 턴 autocompact 안 함)
- `!isPreFirstCompactFork`
- `consecutiveFailures === undefined`
- `!hasAttemptedReactiveCompact`
- `lastTransitionReason !== "precomputed_compact_swap"`
- `uD8()` (Statsig `tengu_sepia_moth`)
- `isReactiveFallbackEnabled` (Statsig `tengu_cobalt_raccoon`)
- `p47(contextTokens, model, autoCompactWindow)` — 토큰이 precompute 시작점 도달

`startPrecomputeFork` 호출 시:
- `precomputeRegistry` (Map<sourceKey, precomputeEntry>) 에 등록 (sourceKey = agentId ?? "main")
- 백그라운드 task 시작: PreCompact hook → `tq6(messages, params)` → 결과 ready
- `tengu_precomputed_compact_started` 텔레메트리
- 다음 턴 PTL 발생 시 `reactiveCompactPhaseA` 가 빌려와서 즉시 swap

### 1.8. Rapid-refill breaker — `rapidRefillCounter` + `rapidRefillCap`

`Qy8(compactTracking)` (14772):
```js
function Qy8(H){
  return H?.compacted === true && H.turnCounter < UE8
       ? (H?.consecutiveRapidRefills ?? 0) + 1
       : 0
}
```
- `UE8 = 3` (compact 후 N턴 이내에 다시 PTL = rapid)
- `oY6 = 3` (3회 연속 rapid 면 차단)

차단 시 `rapidRefillBreakerMsg` (14784, 전문):
```
Autocompact is thrashing: the context refilled to the limit within 3 turns of
the previous compact, 3 times in a row. A file being read or a tool output is
likely too large for the context window. Try reading in smaller chunks, or
use /clear to start fresh.
```

→ user 메시지로 표시 후 turn loop `return {reason:"rapid_refill_breaker"}`. `tengu_auto_compact_rapid_refill_breaker` 텔레메트리.

---

## 2. 핵심 로직 (요약 의사코드)

### 2.1. SDK `sdkCompactionCheck` (oH_)

```js
qHq() {
  const c = CZ.params.compactionControl
  if (!c?.enabled) return false
  let tokens = 0
  if (bx) {
    const m = await bx  // 직전 응답
    tokens = m.usage.input_tokens
           + (m.usage.cache_creation_input_tokens ?? 0)
           + (m.usage.cache_read_input_tokens ?? 0)
           + m.usage.output_tokens
  }
  const threshold = c.contextTokenThreshold ?? HHq  // 1e5 = 100,000
  if (tokens < threshold) return false

  const model = c.model ?? CZ.params.model
  const summaryPrompt = c.summaryPrompt ?? _Hq
  const msgs = CZ.params.messages

  // 1) 마지막 assistant 메시지의 tool_use 블록 제거 (요약 후 무용)
  if (msgs.at(-1).role === "assistant") {
    const last = msgs.at(-1)
    if (Array.isArray(last.content)) {
      const kept = last.content.filter(b => b.type !== "tool_use")
      if (kept.length === 0) msgs.pop()
      else last.content = kept
    }
  }

  // 2) 요약 요청
  const r = await client.beta.messages.create({
    model, max_tokens: CZ.params.max_tokens,
    messages: [...msgs, {role:"user", content:[{type:"text", text: summaryPrompt}]}]
  }, {signal, headers: {..., "x-stainless-helper": "compaction"}})
  if (r.content[0]?.type !== "text") throw new Error("Expected text response")

  // 3) **메시지 전체를 요약본 단일 user 메시지로 교체** (대담함)
  CZ.params.messages = [{role:"user", content: r.content}]
  return true
}
```

### 2.2. CLI autocompact 트리거 판정 `o13`

```js
async function o13(H /*messages*/, _ /*model*/, q /*window*/, K /*querySource*/, O=0){
  if (K === "compact") return false                  // 수동 compact 중엔 자동 안 함
  if (!r0()) return false                            // autoCompactEnabled 게이트
  if (zKH(_) && !oiH(_, q)) return false             // 특정 모델 + env/settings 없음
  const T = Wf(H, rZ(_)) - O                         // 토큰 수
  const $ = zNH(T, _, q)                             // 레벨 계산
  return $.level === "compact" || $.level === "blocked"
}
```

`Wf(messages, model)` (8508): 마지막 assistant 의 usage 합계 + 그 이후 messages 의 `OL` (per-message token estimate) 합.

`zNH(tokens, model, window)` (14777): `T_K(tokens, lHH(model, window), gateConfig, i13(model))` — `{level: "ok"|"warn"|"compact"|"blocked"}` 반환.

### 2.3. iZ — plan mode 모델 스위치 (14057에서 호출)

```js
function iZ({permissionMode, mainLoopModel, exceeds200kTokens=false}){
  if (va() === "opusplan" && permissionMode === "plan" && !exceeds200kTokens) return rk()  // opus(plan용)
  if (va() === "haiku"    && permissionMode === "plan") return ok()  // haiku 변형
  return mainLoopModel
}
```

`Y_6(messages)` (8506): 마지막 assistant usage > 200,000 토큰이면 true → plan mode opus 회피 (큰 컨텍스트에서는 plan 모델로 갈아탐).

### 2.4. b47 — reactive fallback (PTL 도달 가능성) 판정

```js
function b47(H){
  if (H.compactionResult !== undefined) return false        // 이번 턴 이미 autocompact
  if (H.isPreFirstCompactFork) return false
  if (H.consecutiveFailures !== undefined) return false     // 직전 실패
  if (H.hasAttemptedReactiveCompact) return false
  if (H.lastTransitionReason === "precomputed_compact_swap") return false
  if (!uD8()) return false                                  // Statsig sepia_moth
  if (!H.isReactiveFallbackEnabled) return false            // Statsig cobalt_raccoon
  return p47(H.contextTokens, H.model, H.autoCompactWindow) // 토큰 임계
}
```

True 면 `x47({querySource, messages, cacheSafeParams})` 가 background precompute 시작.

---

## 3. State / Schema

### 3.1. `compactTracking` 상태

`runTurnLoop` 의 `D.compactTracking` (변수명 `F`):
```ts
type CompactTracking =
  | undefined                       // 시작 시
  | {
      compacted: false,
      turnId: "",
      turnCounter: number,
      consecutiveFailures: number   // 실패 누적 (≥ z_K=3 이면 disable)
    }
  | {
      compacted: true,
      turnId: string,               // 직전 compact UUID
      turnCounter: number,          // compact 이후 경과 턴 (post-compact turn 마다 ++)
      consecutiveFailures: 0,
      consecutiveRapidRefills: number   // Qy8 누적 카운트
    }
```

전이:
- **autocompact 성공**: `{compacted:true, turnId:uuid, turnCounter:0, consecutiveFailures:0, consecutiveRapidRefills:Qy8(prev)}`
- **autocompact 실패**: `{...prev, consecutiveFailures: prev.consecutiveFailures+1}`. `>= 3` 면 `tengu_auto_compact_circuit_breaker` 발행 후 세션 전체 autocompact 중단.
- **reactive compact 성공**: 위와 동일하되 `transition.reason` = `"precomputed_compact_swap"` 또는 `"reactive_compact_retry"`.
- **rapid-refill 차단**: turn loop 종료 `{reason:"rapid_refill_breaker"}`.

매 post-compact 턴마다 `F.turnCounter++` 발생 (Bq3 14057 마지막부의 `tengu_post_autocompact_turn`).

### 3.2. `compactionResult` (autocompact, reactive 공용 — `a47`/`autocompactImpl` 둘 다 같은 형태)

```ts
{
  boundaryMarker: {
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    isMeta: false,
    timestamp, uuid,
    level: "info",
    compactMetadata: {
      trigger: "auto"|"manual",
      preTokens: number,
      postTokens: number,            // 후처리에서 채워짐
      durationMs: number,
      userContext?, messagesSummarized?,
      preCompactDiscoveredTools?: string[],   // 이전 컴팩트 경계 전에 검색된 도구 이름
      precomputed?: true,
      preservedSegment?: {headUuid, anchorUuid, tailUuid},
      preservedMessages?: {anchorUuid, uuids: string[]}
    },
    logicalParentUuid?: string
  },
  summaryMessages: [user message with <summary> body, isCompactSummary:true, isVisibleInTranscriptOnly:true],
  messagesToKeep: <BareSummaryUser[]>,  // bw5() 로 usage 토큰을 0 으로 마스킹한 보존본
  attachments: <AttachmentMessage[]>,    // todo/plan/skills/agent 재투입
  hookResults: <SessionStart hook 결과>,
  userDisplayMessage?: string,
  preCompactTokenCount, postCompactTokenCount, truePostCompactTokenCount,
  compactionUsage: {input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, ...}
}
```

평탄화 헬퍼 `AKH(r)` (14736):
```js
[r.boundaryMarker, ...r.summaryMessages, ...r.messagesToKeep, ...r.attachments, ...r.hookResults]
```

### 3.3. `sdkCompactionPrompt` (SDK summaryPrompt 기본값) — verbatim

`extracted-functions.js:1938` 부근:
```
You have been working on the task described above but have not yet completed it. Write a continuation summary that will allow you (or another instance of yourself) to resume work efficiently in a future context window where the conversation history will be replaced with this summary. Your summary should be structured, concise, and actionable. Include:
Wrap your summary in <summary></summary> tags.
```

→ 이건 **SDK BetaToolRunner** 의 기본 요약 프롬프트뿐. CLI 의 autocompact/reactive 가 사용하는 `aq6(customInstructions)` 의 본문은 추출본 JS 외부(추정: bun-compiled rodata 의 별도 cstring; 본 추출본에서는 직접 잡히지 않음 — V47 변형 텍스트 `"an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task."` 만 부분 확인).

### 3.4. `gEK({hasThinking})` — `context_management` API 페이로드

`extracted-functions.js:19003`:
```js
function gEK(H) {
  const { hasThinking = false } = H ?? {}
  const q = []
  if (hasThinking) q.push({ type: "clear_thinking_20251015", keep: "all" })
  return q.length > 0 ? { edits: q } : undefined
}
```

→ Anthropic API 가 받는 `context_management` 페이로드는 **`clear_thinking_20251015`** edit 만 포함. `compact_20260112` (서버측 compaction) 는 **CLI 에서 사용 안 함** — CLI 는 자체 compact 로 충분. (단 SDK BetaToolRunner 의 deprecation 경고에서만 언급)

호출 위치 (`buildCreatePayload` builder 19057):
```js
const L6 = gEK({hasThinking: U_})
// ...
const body = {
  ...
  ...L6 && l /*betas allowed*/ && LH.includes(O2H) /*context-management-2025-06-27 beta*/
       && { context_management: L6 }
  ...
}
```

베타 헤더 `O2H = "context-management-2025-06-27"` (4153).

### 3.5. 핵심 상수

| ID | 값 | 의미 |
|---|---|---|
| `sdkCompactionThreshold` | `1e5` (100000) | SDK BetaToolRunner 기본 compact threshold |
| `sdkCompactionPrompt` | (위 텍스트) | SDK 기본 summary prompt |
| `rapidRefillCap` | `3` | "rapid" 판정 (compact 후 N 턴 이내) |
| `rapidRefillCap` | `3` | rapid-refill 누적 한계 (이만큼이면 breaker) |
| `rapidRefillBreakerMsg` | (위 텍스트) | breaker 종료 메시지 |
| `z_K` | `3` | autocompact 연속 실패 차단 임계 |
| `sHK` | (확인 필요) | $rH 의 PTL retry 한계 |
| `nz8` | `20000` | microcompact (Xi9) 활성 토큰 최소 |
| `clearedHintPlaceholder` | `"[Old tool result content cleared]"` | microcompact placeholder |
| `blockingLimitMsg` | (확인) | PTL 에러 메시지 prefix |
| `predicatePromptTooLong` | (7913) | `isPromptTooLongError(msg)` — text 내 `blockingLimitMsg` prefix 검사 |
| `extractTokenGap` | (7915) | PTL 에러에서 `actualTokens - limitTokens` 추출 |
| `contextMgmtBetaHeader` | `"context-management-2025-06-27"` | API beta header |

### 3.6. Statsig gates

| Gate | 변수 | 의미 |
|---|---|---|
| `tengu_cobalt_raccoon` | `Nw_()` | reactive compact 메인 활성화 |
| `tengu_sepia_moth` | `uD8()` | reactive precompute fork 활성화 |
| `tengu_amber_redwood2` | `K96()` | (precompute 보조 — 확인) |
| `tengu_compact_cache_prefix` | (`Z_("tengu_compact_cache_prefix", true)`) | compact 시 prompt-cache prefix 공유 시도 |
| `autoCompactEnabled` (config) | `r0()` | 환경변수 + config 통합 autocompact ON |

### 3.7. 텔레메트리 이벤트 (검증된 이름)

```
tengu_auto_compact_succeeded         (Bq3 — autocompact 성공)
tengu_auto_compact_rapid_refill_breaker  (rapid-refill 차단 — both proactive and reactive 경로)
tengu_auto_compact_circuit_breaker   (consecutiveFailures >= 3)
tengu_compact                        ($rH 본체 — preCompactTokenCount, postCompactTokenCount, truePostCompactTokenCount, isAutoCompact, ...)
tengu_compact_failed                 ({reason: "prompt_too_long"|"no_summary"|"api_error", ...})
tengu_compact_ptl_retry              ($rH 의 PTL retry attempt)
tengu_compact_cache_sharing_success
tengu_compact_cache_sharing_fallback
tengu_reactive_compact_triggered     (o47 진입)
tengu_reactive_compact_attempt       (tq6 각 시도)
tengu_reactive_compact_succeeded     (a47)
tengu_reactive_compact_failed
tengu_precomputed_compact_started    (x47)
tengu_precomputed_compact_ready
tengu_precomputed_compact_failed
tengu_precomputed_compact_discarded  ({reason: "boundary_uuid_missing"|"post_compact_cleanup"|"subagent_exit"|...})
tengu_precompute_borrow_boundary_miss
tengu_post_autocompact_turn          (matched turn counter)
tengu_time_based_microcompact        (Xi9 — context-hint trigger)
tengu_ptl_surfaced_to_user           ({reason: "blocking_limit"|"prompt_too_long"|"image_error", wasGatedByPriorAttempt})
```

### 3.8. PreCompact / PostCompact hooks (29-hook 시스템과 통합)

- **PreCompact** (`lg`, 18793): trigger="auto"|"manual", customInstructions 입력 → 각 hook command 실행 → 결과:
  ```
  { newCustomInstructions?: string,    // 모든 succeeded+!blocked hooks 의 stdout join
    userDisplayMessage?: string,
    blockedBy?: string }               // 첫 blocked hook 의 이유
  ```
  `blockedBy` 있으면 compact 자체가 중단됨.
- **PostCompact** (`PwH` — definition split 됨): trigger, compactSummary 입력 → userDisplayMessage 반환.

**호출 순서** ($rH 기준):
1. `compact_progress` event `{type:"hooks_start", hookType:"pre_compact"}` 발행
2. PreCompact 실행 → blocked 면 중단
3. summary 모델 호출
4. attachments + tool descriptions + `um("compact",...)` SessionStart hook 재실행
5. `compact_progress` event `{type:"hooks_start", hookType:"session_start"}` 발행
6. `compact_progress` event `{type:"hooks_start", hookType:"post_compact"}` 발행
7. PostCompact 실행 → userDisplayMessage 추가

### 3.9. precompute entry 형태 (`rI: Map<string, PrecomputeEntry>`)

```ts
type PrecomputeEntry =
  | { status: "pending",
      precomputedAtUuid: string,           // 백그라운드 시작 시점의 마지막 message uuid
      preCompactTokens: number,
      startedAt: number,
      abortController: AbortController,
      preCompactHookDisplay?: string,
      settled: Promise<void> }
  | { status: "ready",
      result: tq6Result,
      readyDurationMs: number,
      preCompactHookDisplay?: string,
      precomputedAtUuid, preCompactTokens, startedAt, abortController, settled }
```

`xD8: Map<string, number>` — sourceKey 당 시도 횟수 (`precomputeAttemptNumber` 텔레메트리용).

### 3.10. 메시지 그룹 (`SQH` — reactive 의 단위)

```js
function SQH(H) {
  // assistant message id (turn id 역할) 단위로 인접 메시지 묶음
  // 각 그룹: [assistant_msg, ...follow_up_tool_results]
}
```
`tq6` 는 이 그룹 단위로 "마지막 N 그룹은 보존, 앞 그룹들만 요약" 결정. PTL 응답이 오면 보존 그룹 수를 늘려가며 재시도.

---

## 4. 차이점 (v0.2.8 대비)

v0.2.8:
- `/compact` 슬래시 커맨드 **하나만 존재** (수동)
- 자동 트리거 없음
- 요약 후 메시지 교체 단순 동작
- precompute, reactive fallback, breaker, microcompact 전부 없음
- PreCompact/PostCompact hook 없음 (전체 hook 시스템 자체가 없음)
- "context-management" 베타 헤더 없음
- 텔레메트리 분리 없음 (compact 성공/실패만)

v2.1.143 신규:
- **3-tier**: microcompact (자리) + autocompact ($rH) + reactive (tq6 + a47) + SDK qHq
- **트리거 4종**: 토큰 임계 (`o13`), PTL/image 에러 (`reactiveCompactPhaseA`+`reactiveCompactPhaseB`), 백그라운드 precompute (`startPrecomputeFork`), 사용자 `/compact`
- **summary 단위**: assistant-id 그룹 (`SQH`) — 앞 그룹 요약 + 뒤 그룹 보존
- **precompute fork**: 다음 턴 PTL 가능성이 보이면 백그라운드 요약 미리 만들어두고 swap-in
- **rapid-refill breaker**: 3턴 이내 3회 압축 = thrashing 으로 판정해 차단
- **회로 차단**: 연속 3회 압축 실패 시 세션 전체 disable
- **PreCompact / PostCompact / SessionStart (재실행)** hook 통합
- **`compact_progress`/`sdk_status`/`stream_mode`/`response_length`** 4종 이벤트로 UI 실시간 진행 표시
- **boundaryMarker** 의 `preservedSegment/preservedMessages` 메타데이터 — 복구점 표시
- **attachment 재투입**: todos / plan / skills / agent / tool definitions / MCP / SessionStart 결과 모두 압축 후 다시 합쳐 넣음 (단순 요약이 아니라 상태 회복)
- **token gap 기반 적응 step**: PTL 응답의 `actualTokens - limitTokens` 를 다음 시도 step 크기 산정에 사용 (`N47`, `Mw5`)
- **prompt-cache prefix sharing** (`tengu_compact_cache_prefix` gate) — 압축 시 cache hit 시도
- **SDK BetaToolRunner** 의 `compactionControl` 옵션도 동시 제공 (deprecated, 서버측 `compact_20260112` 권장)

---

## 부록: 호출 위치 인덱스 (extracted-functions.js)

| 라인/근처 | 정의 |
|---|---|
| 1942 | `BetaToolRunner` 클래스, `sdkCompactionCheck` 메서드, `sdkCompactionThreshold`, `sdkCompactionPrompt` 상수 |
| 4153 | `contextMgmtBetaHeader` 베타 헤더 |
| 4203 | `iZ` (permissionMode → model) |
| 7913 | `predicatePromptTooLong` (isPromptTooLongError) |
| 7915 | `extractTokenGap` (PTL token gap) |
| 7920 | `ye_` (image too large) |
| 8290 | `G7H` (main session) |
| 8419 | `microcompactNoop` (microcompact = no-op) |
| 8424 | `timeBasedMicrocompact` (실제 microcompact — context-hint) |
| 8506 | `Y_6` (200k 초과 검사) |
| 8508 | `estimateTokensForModel` (messages 토큰 추정) |
| 8623 | `PYH` (compaction 텔레메트리 헬퍼) |
| 9772 | `um` (SessionStart hook 진입) |
| 9853 | `Dw5` (reactive 단일 요약 시도) |
| 9854 | `N47` / `Mw5` (token gap step) |
| 9857 | `tq6` (reactive 본체) |
| 9870 | `_96` (sourceKey 정규화) |
| 9871 | `uD8` (Statsig sepia_moth) |
| 9874 | `decideReactiveCompact` (reactive fallback 결정) |
| 9875 | `startPrecomputeFork` (precompute fork 시작) |
| 9876 | `H96` (precompute entry mutate) |
| 9877 | `Xw5` (precompute lookup) |
| 9879 | `Pw5` (borrow await) |
| 9881 | `Ww5` (own precompute await) |
| 9883 | `reactiveCompactPhaseA` (reactive phase A) |
| 9885 | `m47` (precompute discard 텔레메트리) |
| 9886 | `q96` (precompute abort) |
| 9888 | `sn` (post-compact cleanup) |
| 9889 | `Nw_` (Statsig cobalt_raccoon) |
| 9890 | `zKH` (특정 모델 검사) |
| 9891 | `predicateApiError` (PTL assistant 검사) |
| 9892 | `predicateImageError` (image error assistant 검사) |
| 9894 | `reactiveCompactPhaseB` (reactive phase B) |
| 9897 | `oD8` (reactive summary 진입) |
| 9899 | `a47` (요약 후처리 — boundary, hooks, telem) |
| 9902 | `xw5` (attachments + hooks 재투입) |
| 14045 | `defaultLoopDeps` (deps factory — microcompact:pt, autocompact:Ia7) |
| 14057 | `runTurnLoop` (메인 turn loop) |
| 14734 | `tHK` (compact PTL retry 메시지 자르기) |
| 14736 | `flattenCompactionResult` (compactionResult 평탄화) |
| 14737 | `aD8` (boundaryMarker preserved* 메타 추가) |
| 14741 | `autocompactImpl` (autocompact / 수동 compact 본체) |
| 14749 | `__K` (compact 모델 호출 + cache sharing) |
| 14766 | `K96` (Statsig amber_redwood2) |
| 14769 | `oiH` (model env/settings source 검사) |
| 14770 | `lHH` (effective window) |
| 14772 | `rapidRefillCounter` (rapid refill 카운터) |
| 14776 | `Mh8` (autoCompactThreshold) |
| 14777 | `contextPressureLevel` (token gap level) |
| 14779 | `r0` (autoCompactEnabled) |
| 14780 | `o13` (autocompact 트리거 판정) |
| 14782 | `runAutocompact` (autocompact 진입) |
| 14784 | `compactProgressQueue` (yield wrapper), `oY6=3`, `rapidRefillBreakerMsg` 메시지 |
| 14862 | `OL` (messages 토큰 합) |
| 15589 | `vw_` (compact_boundary 마커 생성) |
| 18793 | `lg` (PreCompact hook) |
| 19003 | `buildContextMgmtParam` (context_management 페이로드) |
| 19024 | `TSK` (context_hint reject → Xi9 호출) |
| 19057 | `buildCreatePayload` (messages.create payload builder, `buildContextMgmtParam` 사용처) |
