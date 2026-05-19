# Agent turn loop (`runTurnLoop`)

추출 위치: [`extracted-functions.js:14057`](../../extracted-functions.js#L14057) — 약 20,889자 / 단일 라인 / `async function*`.

v0.2.8의 `query()` 재귀 generator가 사라지고, v2.1.143은 **단일 `while (true)` 루프 + transition state machine** 으로 같은 일을 한다. 한 호출이 하나의 "user prompt → terminal reason" 전체 시퀀스를 끝까지 처리하며, 다음 턴은 재귀가 아니라 `D` 객체를 갱신하고 `continue` 한다.

진입 시그니처 (확인):

```
async function* Bq3(H, _) → AsyncGenerator<TurnEvent, { reason: string, ... }>
```

- `H` — 입력 페이로드. `{ systemPrompt, userContext, systemContext, canUseTool, fallbackModel, querySource, spawnedBySkill, maxTurns, skipCacheWrite, forkPointUuid, messages, toolUseContext, maxOutputTokensOverride, stopHookActive, deps?, taskBudget? }` 가 디스트럭처된다.
- `_` — 처리된 메시지 큐 uuid 누적 배열 (caller가 lifecycle 추적용으로 전달; loop 내부에서 `_.push(uuid)`로만 사용).

## 1. 호출 그래프

```
Bq3
├─ Sa7()                                  # deps 기본값 (callModel/microcompact/autocompact/uuid/now)
├─ ya7()                                  # gates/sessionId 스냅샷
├─ ga7(messages, ctx, querySource)        # 메모리-디렉토리 prefetch (using P = ...)
│    └─ [Symbol.dispose]() 가 텔레메트리 emit + abort
├─ (loop turn body)
│  ├─ Uy8().startSkillDiscoveryPrefetch
│  ├─ ZA / cr9                            # 메시지 정규화 + content replacement
│  ├─ J.microcompact(...)                 # tier 1 compaction (조용히 잘라냄)
│  ├─ J.autocompact(...)  = Ia7           # tier 2: yield* 로 진행 이벤트 흘림
│  │    └─ rY6($rH, ctx)                  # 내부 wrapper
│  ├─ b47({...}) / x47({...})             # precomputed-compact 트리거 판단/시작
│  ├─ zNH                                 # context window 사용량 (blocking_limit 체크)
│  ├─ try { while (DH) { ... J.callModel(...) ... } } # 한 턴의 model 스트림
│  │    ├─ for await stream
│  │    │    ├─ TH.addTool / TH.getCompletedResults  # gX_ streaming exec
│  │    │    └─ backfillObservableInput               # tool_use input 보강
│  │    └─ catch (ANH) → fallback model swap → continue inner
│  ├─ catch (Error) → image_error | model_error 종료
│  ├─ rY6(u47, ctx) + rY6(o47, ctx)        # tier 3: reactive compact (PTL 회복)
│  ├─ Va7(...)                            # Stop / SubagentStop / TaskCompleted / TeammateIdle hooks
│  ├─ TH.getRemainingResults() / Hj_(...) # tool batch 실행
│  │    └─ Hj_ → y05 (concurrent) | v05 (serial)
│  ├─ t47 + da7                            # PostTurnSummary 비동기 시작
│  ├─ qP_ ("PostToolBatch" hook)
│  ├─ SnH(messageQueue 처리)
│  ├─ refreshTools / refreshMcpClients
│  └─ D = 새 state; continue
└─ return { reason: "..." }
```

핵심 호출 경로 매핑:

| 호출 | 정의 위치 | 역할 |
|---|---|---|
| `Sa7()` | [`extracted-functions.js:14045`](../../extracted-functions.js#L14045) | 기본 deps 빌더 |
| `ya7()` | [`extracted-functions.js:14044`](../../extracted-functions.js#L14044) | gates/sessionId 스냅샷 |
| `ga7(...)` | [`extracted-functions.js:14303`](../../extracted-functions.js#L14303) | `using` disposable resource — memdir prefetch |
| `runAutocompact` (= `J.autocompact`) | [`extracted-functions.js:14782`](../../extracted-functions.js#L14782) | autocompact (yield* generator) |
| `rY6(work, ctx)` | [`extracted-functions.js:14784`](../../extracted-functions.js#L14784) | compact 작업을 진행 이벤트와 합류시키는 큐 wrapper |
| `u47(...)` | [`extracted-functions.js:9883`](../../extracted-functions.js#L9883) | reactive compact phase A — precomputed swap 시도 |
| `o47(...)` | [`extracted-functions.js:9894`](../../extracted-functions.js#L9894) | reactive compact phase B — 사용자-대기 동안 실제 요약 |
| `b47(...)` | [`extracted-functions.js:9874`](../../extracted-functions.js#L9874) | precomputed-compact 트리거 조건 평가 |
| `x47(...)` | [`extracted-functions.js:9875`](../../extracted-functions.js#L9875) | precomputed-compact 비동기 시작 |
| `Va7(...)` | [`extracted-functions.js:14043`](../../extracted-functions.js#L14043) | Stop/SubagentStop hooks (+ TaskCompleted/TeammateIdle 후 처리) |
| `StreamingToolExecutor` class | [`extracted-functions.js`](../../extracted-functions.js) (`Jo7` 모듈) | streaming tool execution 컨테이너 |
| `Hj_(...)` | [`extracted-functions.js:10727`](../../extracted-functions.js#L10727) | tool batch dispatcher (`runConcurrentTools`/`runSerialTools` 분기) |
| `FallbackTriggeredError` (예외) | [`extracted-functions.js:15638`](../../extracted-functions.js#L15638) | `FallbackTriggeredError` |
| `AKH(compactionResult)` | [`extracted-functions.js:14736`](../../extracted-functions.js#L14736) | compact 결과 → boundary+summary+keep+attachments+hook 메시지 평탄화 |
| `Uq3(messages)` | [`extracted-functions.js:14058`](../../extracted-functions.js#L14058) | 마지막 turn boundary index 계산 |
| `Fa7(msg)` | [`extracted-functions.js:14053`](../../extracted-functions.js#L14053) | `apiError === "max_output_tokens"` predicate |
| `r47(msg)` / `rD8(msg)` | [`extracted-functions.js:9891`](../../extracted-functions.js#L9891), [`9892`](../../extracted-functions.js#L9892) | API 오류 메시지 분류 (PTL/이미지) |

## 2. 핵심 로직 (의사코드)

```
function* Bq3({systemPrompt, userContext, systemContext, canUseTool, fallbackModel,
               querySource, maxTurns, taskBudget, ..., deps=Sa7()}, lifecycleUuids) {
  const J = deps   // { callModel, microcompact, autocompact, uuid, now }
  let D = {                                  // 턴 사이에 carry되는 state
    messages, toolUseContext,
    maxOutputTokensOverride, compactTracking: undefined,
    stopHookActive: H.stopHookActive ?? false,
    stopHookBlockingCount: 0,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    turnCount: 1,
    pendingToolUseSummary: undefined,
    transition: undefined,                   // 이전 turn이 왜 다시 진입했는지
  }
  const X = ya7()                             // gates snapshot
  using P = ga7(D.messages, D.toolUseContext, querySource) // ES2026 disposable

  while (true) {
    // ── turn-start 정리 ──
    yield { type: "stream_request_start" }
    const turnCtx = { ...D.toolUseContext, queryTracking: { chainId, depth+1 } }
    let msgs = normalize(D.messages)          // ZA + cr9 (content replacement)

    // ── tier 1: microcompact (silent) ──
    msgs = (await J.microcompact(msgs, turnCtx, querySource)).messages

    // ── tier 2: autocompact (yield* — emits progress) ──
    let { compactionResult, consecutiveFailures, consecutiveRapidRefills,
          rapidRefillBreakerTripped } =
        yield* J.autocompact(msgs, turnCtx, cacheSafeParams, querySource, F)

    if (rapidRefillBreakerTripped) {
      yield buildApiErrorMsg(gy8 /*“autocompact thrashing”*/)
      return { reason: "rapid_refill_breaker" }
    }
    if (compactionResult) {
      F = { compacted:true, turnId:uuid(), turnCounter:0, consecutiveFailures:0,
            consecutiveRapidRefills }
      for (const m of AKH(compactionResult)) yield m
      msgs = AKH(compactionResult)
      taskBudgetRemaining -= sizeOf(msgs)
    } else if (consecutiveFailures !== undefined) {
      F.consecutiveFailures = consecutiveFailures
    }

    // ── 옵션: precomputed compact 백그라운드 시작 ──
    if (b47({...})) x47({querySource, messages: msgs, cacheSafeParams})

    // ── context blocking-limit (compact 직후 등 예외상황 제외) ──
    if (!compactionResult && querySource!=="compact" && !skipBlock) {
      if (zNH(tokens(msgs)).level === "blocked") {
        yield buildApiErrorMsg(wg)
        return { reason: "blocking_limit" }
      }
    }

    // ── streaming-tool-execution 컨테이너 ──
    const TH = X.gates.streamingToolExecution
              ? new gX_(tools, canUseTool, turnCtx) : null

    // ── inner retry loop (모델 fallback 1회 재시도 전용) ──
    let DH = true   // "run-the-model-again-this-turn"
    let collectedAssistant = [], collectedToolResults = [], pendingToolUses = []
    let sawToolUse = false, latestStopReason = null

    try { while (DH) { DH = false
      try {
        let onStreamingFallback = false

        for await (const ev of J.callModel({
          messages: msgs,
          systemPrompt: builtSystemPrompt,
          thinkingConfig, tools, signal,
          options: {
            model: resolvedModelId,
            fallbackModel,
            onStreamingFallback: () => { onStreamingFallback = true },
            onHintCleared: (ids, contentMap) => {
              pendingEvents.push({type:"hint_clears", ids, contentById})
              msgs = pruneClearedHints(msgs, ids, contentMap)
            },
            maxOutputTokensOverride, ...allTheRest
          }
        })) {
          // 1. mid-stream fallback (model→fallbackModel during stream)
          if (onStreamingFallback) {
            for (const m of collectedAssistant)
              yield { type:"tombstone", message:m }
            reset collectedAssistant/toolResults/pendingToolUses/sawToolUse
            if (TH) { TH.discard(); TH = new gX_(...) }
          }

          // 2. tool_use input 보강 (backfillObservableInput)
          let outEvent = ev
          if (ev.type === "assistant") { ...patch missing observable fields... }

          // 3. message_delta 의 stop_reason 추적 (latestStopReason)
          if (ev.type==="stream_event" && ev.event.type==="message_delta") {
            latestStopReason = ev.event.delta.stop_reason
            // 이미 patch한 assistant 메시지들에 usage/stop_reason 역주입
          }

          // 4. PTL/이미지/max_output_tokens 오류 메시지는 yield 지연
          //    (이번 턴 마지막에 별도 분기로 처리)
          //    flag = r47(ev) || rD8(ev) || Fa7(ev)
          if (!flag) yield outEvent

          if (ev.type === "assistant") {
            collectedAssistant.push(ev)
            const toolUses = ev.message.content.filter(c=>c.type==="tool_use")
            if (toolUses.length) { pendingToolUses.push(...toolUses); sawToolUse=true }
            if (TH && !aborted) for (const t of toolUses) TH.addTool(t, ev)
          }

          if (TH && !aborted)
            for (const r of TH.getCompletedResults()) {
              if (isBridgeEvent(r)) { yield r; continue }
              yield r.message
              collectedToolResults.push(...userResults(r.message))
            }
        }
      } catch (err) {
        if (err instanceof ANH && fallbackModel) {
          // ── model fallback path ──
          resolvedModelId = fallbackModel
          DH = true                                   // 같은 턴 재시도
          for (const m of collectedAssistant)
            yield { type:"tombstone", message:m }
          reset collected*; if (TH) { TH.discard(); TH = new gX_(...) }
          turnCtx.options.mainLoopModel = fallbackModel
          yield warningNotification("Switched to <fb> due to high demand for <orig>")
          continue                                    // inner while → 재호출
        }
        throw err
      }
    } } catch (outerErr) {
      // ── 치명 오류 → 종료 ──
      if (outerErr instanceof mUH || outerErr instanceof iF) {
        // 이미지 처리 실패
        yield buildApiErrorMsg(outerErr.message)
        return { reason: "image_error" }
      }
      yield* Ua7(collectedAssistant, errMsg, J)        // tombstone partial
      yield buildApiErrorMsg(errMsg)
      return { reason: "model_error", error: outerErr }
    }

    // ── stream 끝났음. 이번 턴의 결정들 ──
    if (signal.aborted) {
      yield remaining tool results / partial tombstones
      return { reason: "aborted_streaming" }
    }

    // pendingToolUseSummary (이전 턴이 시작해둔 PostTurnSummary)
    if (E) yield (await E)

    if (!sawToolUse) {
      // ── 마지막 응답이 PTL/image 오류였나? ──
      const last = collectedAssistant.at(-1)
      const isPTL413  = last?.isApiErrorMessage && OGH(last)
      const isImgErr  = !isToolUseDenied(last) && rD8(last)
      if (isPTL413 || isImgErr) {
        const refills = Qy8(F)
        if (!hasAttemptedReactiveCompact && refills >= oY6 /*=3*/) {
          yield buildApiErrorMsg(gy8); return { reason: "rapid_refill_breaker" }
        }
        // ── tier 3: reactive compact (2-phase) ──
        const { swap, emittedEarlyCompactStart } =
            yield* rY6(ctx => u47({...isWithheld413, ...}), turnCtx)
        const compactResult =
            yield* rY6(ctx => o47({...precomputed:swap, ...}), turnCtx)
        if (compactResult) {
          for (const m of AKH(compactResult)) yield m
          F = { compacted:true, ... }
          D = { messages: AKH(compactResult), ...,
                hasAttemptedReactiveCompact: swap === undefined,
                transition: { reason: swap ? "precomputed_compact_swap"
                                           : "reactive_compact_retry" } }
          continue                                    // re-enter outer loop
        }
        if (emittedEarlyCompactStart) {
          yield { type:"compact_progress", event:{type:"compact_end"} }
          yield { type:"sdk_status", status: null }
        }
        const reason = isImgErr ? "image_error" : "prompt_too_long"
        yield last
        return { reason }
      }

      if (Fa7(last) /* apiError === max_output_tokens */) {
        if (maxOutputTokensRecoveryCount < mq3 /*=3*/) {
          const meta = makeMeta("Output token limit hit. Resume directly — no apology...")
          yield meta
          D = { messages: [...msgs, ...collectedAssistant, meta], ...,
                maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
                transition: { reason: "max_output_tokens_recovery",
                              attempt: maxOutputTokensRecoveryCount+1 } }
          continue
        }
        yield last                                    // give up, surface as terminal
      }

      // ── malformed tool_use: stop_reason == "tool_use" 인데 pendingToolUses 빈경우 ──
      if (latestStopReason === "tool_use" && pendingToolUses.length === 0) {
        const willRetry = D.transition?.reason !== "malformed_tool_use_retry"
        if (willRetry) {
          const meta = makeMeta("Your tool call was malformed and could not be parsed. Please retry.")
          yield meta
          D = { messages: [...msgs, ...collectedAssistant, meta], ...,
                transition: { reason: "malformed_tool_use_retry" } }
          continue
        }
        yield buildApiErrorMsg("The model's tool call could not be parsed (retry also failed).")
        return { reason: "completed" }
      }

      if (last?.isApiErrorMessage) return { reason: "completed" }

      // ── Stop hook (Va7) ──
      const stopRes = yield* Va7(msgs, collectedAssistant, ...,
                                 stopHookActive, currentTurnId)
      if (stopRes.preventContinuation) return { reason: "stop_hook_prevented" }
      if (stopRes.blockingErrors.length > 0) {
        const nextTurnCount = turnCount + 1
        const nextBlockCount = stopHookBlockingCount + 1
        if (maxTurns && nextTurnCount > maxTurns) {
          yield { type:"max_turns_reached", maxTurns, turnCount: nextTurnCount }
          return { reason: "max_turns", turnCount: nextTurnCount }
        }
        const cap = parseInt(env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP ?? "", 10) || 8
        if (cap > 0 && nextBlockCount > cap) {
          yield warningNotification("A hook blocked the turn from ending N consecutive
                                    times — overriding and ending turn. ...")
          return { reason: "completed" }
        }
        D = { messages:[...msgs, ...collectedAssistant, ...stopRes.blockingErrors], ...,
              stopHookActive: true,
              stopHookBlockingCount: nextBlockCount,
              turnCount: nextTurnCount,
              transition: { reason: "stop_hook_blocking" } }
        continue
      }
      return { reason: "completed" }
    }

    // ── tool_use가 있는 정상 경로: tool batch 실행 ──
    const toolStream = TH ? TH.getRemainingResults()
                          : Hj_(pendingToolUses, collectedAssistant, canUseTool, turnCtx)
    let hookStopped = false, hookDeferred = false, dh = turnCtx
    for await (const t of toolStream) {
      if (isBridge(t)) { yield t; continue }
      yield t.message
      if (attachment === "hook_stopped_continuation") hookStopped = true
      if (attachment === "hook_deferred_tool") hookDeferred = true
      collectedToolResults.push(...userResults(t.message))
      if (t.newContext) dh = { ...t.newContext, queryTracking }
    }

    // PostTurnSummary 비동기 시작 (X.gates.emitToolUseSummaries)
    if (...) rH = t47({tools, signal, ...}).then(...)

    if (signal.aborted) return { reason: "aborted_tools" }
    if (hookDeferred) return { reason: "tool_deferred" }
    if (hookStopped)  return { reason: "hook_stopped" }

    // ── 특수 케이스: 단일 TaskStop tool + dynamic loop wakeup ──
    if (pendingToolUses.length === 1 &&
        pendingToolUses[0].name === az &&  // 추정: TaskStop 또는 SchedWakeup
        Hr_(model) && zR().some(/*loop kind w/ same prompt*/)) {
      yield* ka7(...)                       // loop-end housekeeping
      return { reason: "completed" }
    }

    if (F?.compacted) F.turnCounter++       // compact 후 경과 턴 카운트

    // ── PostToolBatch hook (29 hooks 중 하나) ──
    if (JS("PostToolBatch", ...)) { ... yield results, maybe abort/stop ... }

    // ── message queue 처리 (사용자가 끼워넣은 prompt) + memdir prefetch flush ──
    for await (const ev of SnH(null, dh, null, queuedPrompts, msgs, querySource))
      yield ev
    if (P && P.settledAt !== null) {        // ga7 prefetch
      for (const r of Qa7(await P.promise, readFileState)) {
        const ev = T9(r); yield ev; collectedToolResults.push(ev)
      }
    }

    // refresh tools/MCP clients
    if (dh.options.refreshTools) dh = {... new tools ...}
    if (dh.options.refreshMcpClients) dh = {... new clients ...}

    const nextTurnCount = turnCount + 1
    if (maxTurns && nextTurnCount > maxTurns) {
      yield { type:"max_turns_reached", maxTurns, turnCount: nextTurnCount }
      return { reason: "max_turns", turnCount: nextTurnCount }
    }

    // ── 정상 다음-턴 진입 ──
    D = { messages: [...msgs, ...collectedAssistant, ...collectedToolResults],
          toolUseContext: dh,
          compactTracking: F,
          turnCount: nextTurnCount,
          maxOutputTokensRecoveryCount: 0,
          hasAttemptedReactiveCompact: false,
          pendingToolUseSummary: rH,
          maxOutputTokensOverride: undefined,
          stopHookActive: stopHookActive,
          stopHookBlockingCount: 0,
          transition: { reason: "next_turn" } }
    // 루프 자연 진행
  }
}
```

`continue` 지점 7곳 (확인):

| # | 위치 | transition.reason 설정값 |
|---|---|---|
| 1 | inner-loop `FallbackTriggeredError` catch | (transition 미변경; same-turn) |
| 2 | tier 3 reactive compact 성공 | `precomputed_compact_swap` 또는 `reactive_compact_retry` |
| 3 | `Fa7(last)` & `maxOutputTokensRecoveryCount < 3` | `max_output_tokens_recovery` |
| 4 | malformed tool_use & 첫 시도 | `malformed_tool_use_retry` |
| 5 | Stop hook blocking errors | `stop_hook_blocking` |
| 6 | (없음 — `D = {...next_turn}` 후 while 자연순환) | `next_turn` |

`return` 지점 (12종 확인):

| # | reason | 조건 |
|---|---|---|
| 1 | `rapid_refill_breaker` (autocompact) | `s == true` (`runAutocompact` 가 breaker tripped 리턴) |
| 2 | `blocking_limit` | context 사용량이 `zNH(...).level === "blocked"` (compact 아닌 정상 진입에서만; `contextPressureLevel`는 4-tier `ok|warn|compact|blocked` — `compact-flatten.md` §3 참조) |
| 3 | `image_error` | `mUH`/`iF` 예외 (외부) 또는 응답 메시지가 `rD8(last)` predicate에 통과 |
| 4 | `model_error` | streaming/callModel 단계에서 기타 예외 |
| 5 | `aborted_streaming` | streaming 중 `signal.aborted` |
| 6 | `aborted_tools` | tool 실행/PostToolBatch 중 `signal.aborted` |
| 7 | `prompt_too_long` | 응답이 PTL(413/`predicatePromptTooLong`) 이고 reactive compact 모두 실패 |
| 8 | `completed` (정상 경로) | tool_use 없음 + Stop hook 통과 |
| 9 | `completed` (max_output_tokens 포기) | `Fa7(last)` 이지만 retry 3회 초과 — `yield last` 후 다른 로직으로 빠지지 않으면 다음 분기에서 처리 (실제로는 retry 가능하면 continue, 아니면 그대로 fallthrough — 코드 흐름상 다음 if를 거쳐 `completed`로 떨어짐, **추정**) |
| 10 | `completed` (malformed retry 실패) | retry 시도 후에도 또 malformed |
| 11 | `completed` (`isApiErrorMessage`) | last response가 일반 API 오류 메시지 |
| 12 | `completed` (Stop block cap 초과) | `stopHookBlockingCount > cap` |
| 13 | `completed` (loop dynamic wakeup) | 단일 TaskStop/SchedWakeup tool 매칭 |
| 14 | `stop_hook_prevented` | Stop hook이 `preventContinuation: true` |
| 15 | `max_turns` | `turnCount > maxTurns` |
| 16 | `tool_deferred` | tool 결과에 `hook_deferred_tool` attachment |
| 17 | `hook_stopped` | tool/PostToolBatch 결과에 `hook_stopped_continuation` |

(요청서의 7종 + 코드에서 추가 발견된 5종.)

## 3. State / Schema

### 3.1 `D` 객체 (turn-carry state)

[`extracted-functions.js:14057`](../../extracted-functions.js#L14057) 의 진입 직후 초기화 + 모든 `continue` 직전 재할당으로 변이됨.

| 필드 | 타입 | 의미 | 리셋 시점 |
|---|---|---|---|
| `messages` | `Message[]` | 다음 턴에 모델로 보낼 메시지 누적 | 매 `continue` 마다 재구성 |
| `toolUseContext` | `ToolUseContext` (`forkToolUseContext`-built) | 도구 디스패치/세션 상태 컨테이너 | `next_turn`에서 `eH` (`dh` + 갱신된 queryTracking) 사용 |
| `compactTracking` | `{compacted, turnId, turnCounter, consecutiveFailures, consecutiveRapidRefills}?` | tier 2/3 compact 결과 추적 | autocompact가 성공할 때마다 `{compacted:true, turnId:new, turnCounter:0, ...}` 로 재초기화 |
| `transition` | `{reason: string, attempt?: number}?` | "왜 이 턴이 시작되었나" — retry/recovery 분기 인식 | 매 `continue` 에서 새로 부여; 정상 진입에선 `{reason:"next_turn"}` |
| `turnCount` | `number` (1부터) | 사용자-인식 턴 카운터. `maxTurns` 비교 | 정상 진행/Stop block 진행 시 +1; retry/compact 류는 유지 |
| `stopHookActive` | `boolean` | Stop hook payload에 `stop_hook_active: true` 표시할지 | `stop_hook_blocking` 분기에서 `true`로 설정, 정상 next_turn에서는 carry |
| `stopHookBlockingCount` | `number` | Stop hook이 연속으로 차단한 횟수 | 정상 next_turn/대부분 분기에서 0으로 리셋; `stop_hook_blocking`에서만 +1 |
| `maxOutputTokensRecoveryCount` | `number` | "Output token limit hit. Resume..." meta를 주입한 횟수 | `max_output_tokens_recovery` 에서만 +1; 다른 모든 분기/next_turn에서 0 리셋 |
| `hasAttemptedReactiveCompact` | `boolean` | 이번 "메시지 묶음"에서 이미 reactive compact를 시도했나 | reactive compact 성공 후 `swap === undefined` (즉 phase B로 직접 compact 했을 때) 면 true 유지; precomputed swap이면 false (또 시도 가능 표시); next_turn/대부분 분기에서 false |
| `maxOutputTokensOverride` | `number?` | callModel 옵션으로 전달되는 max_tokens 오버라이드 | 모든 `continue` 에서 undefined로 리셋 (즉 caller가 처음에만 설정 가능) |
| `pendingToolUseSummary` | `Promise<Message?>?` | 이전 턴에 시작된 PostTurnSummary가 다음 턴 시작 시 도착 | next_turn에서 `rH` (이번 턴이 시작한 promise) 로 설정; 그 외 분기에선 undefined 리셋 |

검증 노트: `turnCount` 는 max_output_tokens / malformed retry / stop_hook block 모두에서 동일하게 carry되며 (`turnCount: C`), 진짜 "도구 실행 후 다음 모델 호출"에 들어갈 때만 `C+1` 된다 — 확인.

### 3.2 `transition.reason` 값 카탈로그

(전부 코드 검색으로 발견된 문자열 — 확인)

| `reason` | 발생 분기 | 효과 |
|---|---|---|
| `malformed_tool_use_retry` | stop_reason="tool_use" + pendingToolUses 비어있음 + 첫 시도 | meta msg 주입 + retry (재시도 시 같은 분기 들어오면 종료) |
| `reactive_compact_retry` | `reactiveCompactPhaseB` 가 swap 없이 직접 요약 성공 | compact 결과로 D.messages 교체 → 모델 재호출 |
| `precomputed_compact_swap` | `reactiveCompactPhaseA` 가 사전계산된 compact 결과를 swap-in | compact 결과로 D.messages 교체 (precomputed가 borrow이므로 `hasAttemptedReactiveCompact:false`로 둠) |
| `max_output_tokens_recovery` | API가 `apiError === "max_output_tokens"` 로 잘림 | "Resume directly..." meta 주입 후 재호출 (최대 3회, `mq3=3`) |
| `stop_hook_blocking` | Stop/SubagentStop hook이 blocking error 반환 | blocking error 메시지를 messages에 append하고 모델 재호출 |
| `next_turn` | tool 실행 후 정상 진행 | 도구 결과 포함해 다음 턴 |

(첫 진입 시 `transition` 은 `undefined` — 확인.)

### 3.3 종료 reason 카탈로그

§2 표 참고. 모두 코드에서 실제 `return { reason: "..." }` 형태로 발견.

### 3.4 `J` deps 객체 (`Sa7()` default)

[`extracted-functions.js:14045`](../../extracted-functions.js#L14045) (확인):

```
function Sa7() {
  return {
    callModel:   NiH,                  // call-model.md 모듈의 retry-layer entry
    microcompact: pt,                  // compaction-system.md tier 1
    autocompact:  Ia7,                 // compaction-system.md tier 2 (generator)
    uuid:         require("crypto").randomUUID,
    now:          () => new Date().toISOString(),
  }
}
```

caller가 `H.deps`를 넘기면 그걸로 대체 (SDK / 테스트용). gates 스냅샷 `X = ya7()` 은 별개:

```
{ sessionId, gates: { streamingToolExecution, emitToolUseSummaries, isAnt, fastModeEnabled } }
```

### 3.5 `using P = ga7(...)` 의 의미

[`extracted-functions.js:14303`](../../extracted-functions.js#L14303) (확인). `startMemdirPrefetch` 은 다음 조건이 모두 충족될 때만 객체를 리턴 (아니면 `undefined`):

- `_.memorySelector` 존재 (memdir feature 활성)
- 서브에이전트 아님 (`!_.agentId`)
- `b4()` 통과 (사용자 인증)
- Statsig gate `tengu_moth_copse` 켜져 있음
- 최근 user 메시지가 공백 포함 (단어로 구성)
- 세션 바이트가 `MAX_SESSION_BYTES = 61_440` 미만 (확인)
- `querySource`가 `J73` exclude set에 없음 — 자세한 가드는 [`agent-loop-memdir-prefetch.md`](agent-loop-memdir-prefetch.md) 참조

리턴되는 객체 형상:

```
{
  promise:        Promise<MemDirResult[]>,   // 비동기 prefetch
  settledAt:      number | null,
  consumedOnIteration: number,                // -1=미소비
  [Symbol.dispose]() {                        // ← using 으로 호출됨
    z.abort()                                 // AbortController 종료
    d("tengu_memdir_prefetch_collected", { ... })  // 텔레메트리
  }
}
```

`runTurnLoop` 종료 시점 (어떤 reason이든) `using` 선언이 ES2026 spec 따라 자동으로 `[Symbol.dispose]()` 를 호출 — 추정 (Bun 컴파일이 transpile 했을 가능성도 있으나 소스상 `using` 키워드 그대로 보임).

루프 안에서 `if (P && P.settledAt !== null && P.consumedOnIteration === -1)` 로 한 번만 consume → tool 결과에 합쳐서 yield (`transformMemdirResults` 으로 변환).

### 3.6 Stop hook block cap

[`extracted-functions.js:14057`](../../extracted-functions.js#L14057) (chunk 4 위치, 확인):

```
let l_ = parseInt(process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP ?? "", 10)
let p_ = Number.isNaN(l_) ? 8 : l_
if (p_ > 0 && B_ > p_) {
  d("tengu_stop_hook_block_count", {count, ..., hit_cap: true})
  yield warningNotification(`A hook blocked the turn from ending ${B_}
    consecutive times — overriding and ending turn. For Stop/SubagentStop hooks,
    check stop_hook_active in the input and return success while it's true.
    Set CLAUDE_CODE_STOP_HOOK_BLOCK_CAP to raise this limit.`)
  return { reason: "completed" }
}
```

- 기본 8, env로 변경 가능.
- 0 또는 음수면 cap 비활성 (무한히 차단 허용).
- 초과 시 `completed` 로 종료 (에러가 아님) + 사용자 경고 yield.
- `stopHookActive` 플래그는 Stop hook payload로 전달되어 Stop hook이 무한 차단 방지에 활용 가능.

### 3.7 모델 fallback (`FallbackTriggeredError`) 경로

`FallbackTriggeredError` (`FallbackTriggeredError`)는 [`call-model.md`](call-model.md)의 retry 레이어가 **`qA3=3` 연속 529 + Opus 모델 + caller가 `fallbackModel` 제공** 모든 조건이 충족될 때만 throw — 자세한 트리거 조건/이력은 [`agent-loop-error-predicates.md`](agent-loop-error-predicates.md) §2 참조.

[`extracted-functions.js:15638`](../../extracted-functions.js#L15638) 에서 `FallbackTriggeredError` 클래스 정의 (`class ANH extends Error`):

```
constructor(originalModel, fallbackModel) {
  super(`Model fallback triggered: ${originalModel} -> ${fallbackModel}`)
  this.originalModel = originalModel
  this.fallbackModel = fallbackModel
  this.name = "FallbackTriggeredError"
}
```

`callModel` 레이어 (`call-model.md` 참조) 가 high-demand 신호를 받았을 때 throw. `runTurnLoop` 의 inner `try` 가 캐치:

```
catch (H_) {
  if (T_.length > 0) yield* T_   // pending events flush
  if (H_ instanceof ANH && $) {  // $ = fallbackModel from caller
    $H = $                        // resolvedModelId := fallbackModel
    DH = true                     // re-run inner while
    for (G_ of collectedAssistant) yield { type:"tombstone", message: G_ }
    reset collected*; if (TH) { TH.discard(); TH = new gX_(...) }
    Z.options.mainLoopModel = $   // ctx도 갱신
    EH("model_fallback")          // 텔레메트리 성공-flag
    d("tengu_model_fallback_triggered", {original_model, fallback_model, entrypoint:"cli", ...})
    yield warningNotification(`Switched to ${nM(fb)} due to high demand for ${nM(orig)}`)
    continue                       // inner while 다시 — same turn, 새 모델로 모델 호출
  }
  throw H_                          // 다른 예외는 outer catch로
}
```

복구는 같은 턴 안에서 일어남 (`turnCount` 증가 없음, `D` 안 바뀜). 이미 받은 partial assistant 메시지들은 클라이언트에 `tombstone` 으로 통지 (UI에서 회색처리/사라지게).

### 3.8 두 컴팩션 호출 사이트

**(a) Top-of-loop autocompact** — 매 턴 시작 시 무조건 호출:

```
const { compactionResult, consecutiveFailures, consecutiveRapidRefills,
        rapidRefillBreakerTripped } =
    yield* J.autocompact(msgs, turnCtx, cacheSafeParams, querySource, F, c)
```

- `J.autocompact` 는 `runAutocompact` (generator). 내부에서 token 사용량이 임계치 미만이면 `{wasCompacted:false}` 만 리턴하고 끝남 — 즉 매 턴 부르되 실제 작업은 임계 도달시만.
- `rapidRefillBreakerTripped` 면 즉시 `rapid_refill_breaker` 종료.
- 성공하면 `compactTracking` 을 새로 짓고 messages를 `AKH(result)` 로 교체. `flattenCompactionResult` 는 한 줄짜리 5-field concat: `[boundary, ...summaryMessages, ...keptMessages, ...attachments, ...hookResults]` — 정확한 모양은 [`agent-loop-compact-flatten.md`](agent-loop-compact-flatten.md) §2 참조.

**(b) Reactive compact (`reactiveCompactPhaseA` + `reactiveCompactPhaseB` + `compactProgressQueue`)** — stream 끝에서 마지막 메시지가 PTL/이미지오류일 때만:

```
if (!sawToolUse && (isPTL413 || isImgErr)) {
  if (!hasAttemptedReactiveCompact && refills(F) >= oY6) {
    return rapid_refill_breaker
  }
  const { swap, emittedEarlyCompactStart } =
      yield* rY6(ctx => u47({ toolUseContext:ctx, messages:msgs,
                              isWithheld413, hasAttemptedReactiveCompact,
                              borrowFrom: isPreFirstCompactFork ? precomputeSourceKey : undefined,
                              ptlDetectedAt, querySource }), turnCtx)
  const compactResult =
      yield* rY6(ctx => o47({ hasAttempted: hasAttemptedReactiveCompact,
                              querySource, aborted, messages, cacheSafeParams,
                              precomputed: swap,
                              userWaitStartedAt: ptlDetectedAt, initialTokenGap }), turnCtx)
  if (compactResult) { ... reactive_compact_retry | precomputed_compact_swap; continue }
  return { reason: isImgErr ? "image_error" : "prompt_too_long" }
}
```

- `reactiveCompactPhaseA` 은 phase A — 백그라운드 precomputed compact (만약 `startPrecomputeFork`이 미리 시작해뒀다면) 결과를 swap-in 시도.
- `reactiveCompactPhaseB` 은 phase B — swap이 없거나 부족하면 실제 사용자-대기 동안 동기 요약 실행.
- `rY6(work, ctx)` 는 work이 실행되는 동안 `onCompactEvent` / `resetResponseLength` / `addResponseLength` / `addNotification` 콜백으로 들어오는 이벤트를 큐(`Pn`)에 모으고 `yield*` 로 그대로 흘려보내는 wrapper — UI가 compact 진행상황을 실시간 볼 수 있게.

성공 경로의 `transition.reason` 은 swap 여부에 따라:
- `swap !== undefined` → `precomputed_compact_swap` (이미 백그라운드에서 만들어 둔 것을 쓴 케이스)
- `swap === undefined` → `reactive_compact_retry` (사용자 대기 중 새로 만든 케이스)

또한 `hasAttemptedReactiveCompact` 는 `swap === undefined` 일 때 `true` (이미 본격 작업 함, 같은 묶음에서 더 안함), `swap !== undefined` 일 때 `false` (borrow는 시도 안한 것과 같음 — 다시 시도 허용). 이게 `p_===void 0` 조건의 의미. 확인.

## 4. yield 프로토콜

루프 일생에서 yield 되는 이벤트 타입 (검색으로 발견된 것 전부):

| `type` | 발생 시점 | 페이로드 |
|---|---|---|
| `stream_request_start` | 모든 turn 진입 시작 | `{}` |
| 일반 stream event | `J.callModel` 이 내부 yield (text_delta, tool_use_delta, message_delta, content_block_start 등) | API SSE 형태 그대로 |
| `assistant` 메시지 | 모델 응답 (input backfill 적용된 사본) | `{type:"assistant", message:{...}}` |
| `tombstone` | streaming fallback OR `FallbackTriggeredError` fallback 후 partial 메시지 무효화 | `{type:"tombstone", message:<원본 assistant msg>}` |
| `compact_progress` | reactive/precomputed compact 진행 (`reactiveCompactPhaseA`/`reactiveCompactPhaseB`이 `onCompactEvent` 로 트리거) | `{type:"compact_progress", event:{type:"compact_start"|"compact_end"|"hooks_start", ...}}` |
| `sdk_status` | compact 시작/끝 시 SDK 컨슈머용 상태 알림 | `{type:"sdk_status", status:"compacting"|null, metadata?:{...}}` |
| `max_turns_reached` | maxTurns 초과 시 종료 직전 | `{type:"max_turns_reached", maxTurns, turnCount}` |
| `hint_clears` | `callModel` 의 `onHintCleared` 콜백 — 모델이 cache hint 블록 지운 경우 (해당 도구 결과는 `lz8="[Old tool result content cleared]"` placeholder로 치환) | `{type:"hint_clears", ids:[...], contentById:{...}}` |
| user (tool_result) | tool 실행 결과 | `{type:"user", message:{role:"user", content:[{type:"tool_result", ...}]}}` |
| `attachment` (hook_*) | hook 결과 (PreToolUse/PostToolUse/PostToolBatch/Stop/...) | `{type:"attachment", attachment:{type:"hook_blocking_error"|"hook_success"|"hook_stopped_continuation"|"hook_deferred_tool"|"hook_additional_context"|...}}` |
| `progress` | 도구가 streaming progress 보낼 때 | `{type:"progress", toolUseID, data:{...}}` |
| 알림 (notification) | `compactProgressQueue` queue를 거쳐 onCompactEvent에서 흘러나옴 | `{type:"notification", notification:{key, text, priority, color, timeoutMs}}` |
| `response_length` | 동일 경로 | `{type:"response_length", op:"add"|"reset", delta?}` |
| `set_in_progress_tool_use_ids` | `StreamingToolExecutor` 가 도구 완료 시 | `{type:"set_in_progress_tool_use_ids", op:{action:"remove", ids:[...]}}` |
| `active_goal` / `goal_status` | Stop hook 안의 goal 평가 (`runStopHooks`) | `{type:"active_goal", value:...}` / `{type:"goal_status", met, ...}` |
| `post_turn_summary` | `runStopHooks`가 시작 표시 (실제 값은 background) | `{type:"post_turn_summary", value:null}` |
| `hook_additional_context` | PostToolBatch hook이 컨텍스트 추가 시 | `T9({type:"hook_additional_context", content, hookName, toolUseID, hookEvent})` |
| `hook_stopped_continuation` | Stop/PostToolBatch hook이 종료 신호 | `T9({type:"hook_stopped_continuation", message, hookName, toolUseID, hookEvent})` |
| 사용자 정의 warning notification | model fallback / stop-cap 초과 시 | `VO(text, "warning")` |

## 5. 차이점 (v0.2.8 → v2.1.143)

| 영역 | v0.2.8 `query()` | v2.1.143 `runTurnLoop` |
|---|---|---|
| 제어 흐름 | **재귀 generator** — 다음 턴은 `yield* query(...)` | **`while(true)` + `D` state + `continue`** — 콜스택 평탄화 |
| 다음 턴 진입 메커니즘 | 함수 인자로 새 messages/ctx 전달 | `D = {...}; continue` — 동일 스코프에서 mutation |
| 턴 사이 metadata | 함수 파라미터에만 존재 | `transition.reason` 으로 "왜 다시 들어왔는지" 명시 |
| 컴팩션 | `/compact` 슬래시 명령 (manual) | 3-tier: top-of-loop `microcompact`+`autocompact`, end-of-turn reactive `reactiveCompactPhaseA`/`reactiveCompactPhaseB`, 백그라운드 precomputed (`startPrecomputeFork`) |
| Rapid-refill 보호 | 없음 | `consecutiveRapidRefills >= 3` (`rapidRefillCap`) → `rapid_refill_breaker` 종료 |
| 모델 fallback | 없음 | `FallbackTriggeredError` 예외 → 같은 turn에서 모델 ID swap + tombstone + 재호출 |
| max_output_tokens 복구 | 없음 | "Resume directly..." meta 자동주입, 최대 3회 (`mq3=3`) |
| Malformed tool_use | 없음 | "your tool call was malformed" meta + 1회 재시도 |
| Stop hook block cap | N/A (Stop hook 자체 없음) | env `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` 기본 8 |
| Streaming tool exec | 없음 (도구는 stream 후 일괄) | `StreamingToolExecutor` — assistant stream 진행 중 tool_use 도착 즉시 실행 가능 |
| Resource mgmt | manual cleanup | `using P = ga7(...)` (ES2026 disposable) |
| Telemetry | 단순 | `queryTracking { chainId, depth }`, 턴마다 `v5("query_*")` 마커 |
| 다음 prompt 큐 | 없음 | `messageQueue.getCommandsByMaxPriority("next")` 처리 후 다음 턴 |
| MCP/도구 핫리로드 | 없음 | `dh.options.refreshTools()` / `refreshMcpClients()` 매 턴 끝 |
| Subagent budget | 없음 | `taskBudget.total - 누적 RA8(msgs)` 차감 |

### 동등 매핑 (개념-수준)

- v0.2.8 의 "재귀 호출 시점" = v2.1.143 의 `D = {... transition: {reason: "next_turn"}}; continue` (도구 결과 누적 후).
- v0.2.8 의 "에러 → throw" = v2.1.143 의 `return { reason: "model_error" | "image_error" | ... }` + caller가 `result.reason` 검사.

### 추정 / 확인 필요

- `using P = ga7(...)` 의 dispose 타이밍은 ES2026 spec 따라 함수 종료 시점 — 실제 Bun 컴파일이 transpile했는지 native disposable인지 미확인. 동작 의미는 분명: 어떤 reason으로 끝나든 cleanup 실행.
- "loop dynamic wakeup" 분기 (`_H[0].name === az` && `Hr_(model)` && `zR().some(...)`): `az` 식별자는 미해석 — `TaskStop` 또는 cron `ScheduleWakeup` 으로 추정. cron-schedule.md에서 교차검증 필요.
- `decideReactiveCompact` (precomputed-compact 트리거 조건) 의 `isPreFirstCompactFork` 분기는 fork session에서만 트리거 — 확인 필요한 시나리오.
- `pendingToolUseSummary` 는 다음 턴 시작 직후 `if (E) yield (await E)` 로 한 번 consume — `E` resolve 값이 null이면 yield 안 함. 확인.

## 6. Deep-dive supplemental docs

§1–§5 가 골격이라면, 아래 12개 문서는 각 영역의 핵심 함수 본문까지 파고든 보강분. 이 본 문서에서 식별자 해석이 모호하거나 "확인 필요" 로 남긴 항목은 거의 모두 보강 문서에서 결론이 났음.

### Round 1 — 루프 제어/회복 메커니즘

| 문서 | 다루는 범위 | 핵심 발견 |
|---|---|---|
| [`agent-loop-stream-events.md`](agent-loop-stream-events.md) | `runTurnLoop` ↔ `callModel` 인터페이스 (모든 stream 이벤트 타입, `backfillObservableInput` 패칭, `onStreamingFallback`/`onHintCleared` 콜백, `latestStopReason` 누적, `T_` 버퍼) | `T_` 버퍼는 `hint_clears` **전용** — 다른 모든 이벤트(`compact_progress`/`sdk_status`/`notification`)는 그 자리에서 직접 yield. `onHintCleared` 콜백이 `extractReadPaths`로 Read-path 추출 + `readFileState.delete(H9(path))` 로 staleness tracking 무효화. `lz8 = "[Old tool result content cleared]"` placeholder. |
| [`agent-loop-memdir-prefetch.md`](agent-loop-memdir-prefetch.md) | `using P = ga7(...)` 의 ga7/Qa7/dispose 전 사이클, `[[name]]` 표기, skill-discovery prefetch 와의 비교 | `MAX_SESSION_BYTES = 61_440`. ga7 가드 6개 + `J73` exclude set. `consumedOnIteration = C-1` (현재 iter 가 아니라 마이너스 1로 마킹). `[[name]]` 은 **write-side convention만** — 자동 로드 코드 없음. nested-memory triggers (`A73`/`St7`) 는 **별도 시스템**. telemetry는 `tengu_memdir_prefetch_collected` 하나뿐 (`_started`/`_skipped` 는 존재하지 않음). |
| [`agent-loop-stop-hook-deep.md`](agent-loop-stop-hook-deep.md) | `runStopHooks` Stop hook runner, `dispatchStopHook` Stop/SubagentStop dispatch, `runPostToolBatchHook` PostToolBatch, `startPostTurnSummary`+`awaitPostTurnSummary` PostTurnSummary, `active_goal`/`goal_status` 평가 | `dispatchStopHook` 는 **단일 trampoline** — `agentId` 유무로 분기 (별도 `SubagentStop` 함수 없음). `runPostToolBatchHook` blockingError 는 **즉시 `hook_stopped` 종료** (Stop hook과 달리 retry 없음). `post_turn_summary value:null` 은 slot reservation; 실제 내용은 `notifyMetadataChanged`/`tv` 시스템 이벤트로 전달 (다음 yield 아님). `tool_use_summary` 는 **다음 턴 시작에** yield (`if (E) yield await E`). `/goal` 슬래시 + `evaluateGoal` LLM evaluator. |
| [`agent-loop-message-queue.md`](agent-loop-message-queue.md) | `SnH`/`makeSystemReminderAttachment` attachment drain, `messageQueue` (3-priority 싱글톤, 18 메서드, `Nc9` slash-cmd 필터), `refreshTools`/`refreshMcpClients` 핫리로드, `maxTurns` 정확한 셈법, `taskBudget`/`estimateMessageTokens` 차감 | `maxTurns` 는 **3 사이트**에서 체크, **5 retry 경로**에서 스킵 (malformed/max_output_tokens/reactive_compact/ANH/stop_hook_block). `RA8(messages)` 는 **누적이 아니라 가장 최근 assistant input+output** 만 카운트 — `taskBudget.remaining` 은 매 compaction 직후 절대값으로 재계산. |
| [`agent-loop-compact-flatten.md`](agent-loop-compact-flatten.md) | `flattenCompactionResult` 5-field concat 정확한 모양, `lastTurnBoundaryIndex` boundary 인덱싱, `contextPressureLevel` 4-tier, 모든 canonical error message body verbatim, 메시지 빌더 `makeApiErrorMessage`/`makeToolResultMessage`/`makeAttachmentMessage`/`makeNotification`/`makeMetaMessage` 시그니처, 13 `v5("query_*")` perf marker | `contextPressureLevel` 는 **4-tier** `ok|warn|compact|blocked` (§1 §3 표의 3-tier 표기는 보강 결과로 정정). `blocking_limit` 메시지 body 는 `wg = "Prompt is too long"` 그대로 (extra suffix 없음). `runStopFailureHook` 는 **StopFailure hook executor** ("set last error" 아님). `rapid_refill_breaker`/`blocking_limit` 종료는 `persistTurnFailure` 만 호출, `runStopFailureHook` 스킵. |
| [`agent-loop-error-predicates.md`](agent-loop-error-predicates.md) | `predicateApiError`/`predicatePromptTooLong`/`predicateImageError`/`ye_`/`YH5`/`predicateMaxOutputTokens`/`extractTokenGap` predicate 정의, `FallbackTriggeredError` 클래스 + Bq3 inner-catch 11단계, `KH` (latestStopReason) 처리, 5 abort 사이트 | **`FallbackTriggeredError` 발생 조건 정정**: 단순 "high demand" 가 아니라 **`qA3 = 3` 연속 529 + Opus 모델 + caller 가 `fallbackModel` 제공** 모두 충족 시. 두 번째 throw 시 cycle-break 없음 (RJ6 백오프/MAX_RETRIES 에 의존). `Ba7` 는 **module-init `null`** — v2.1.143 에선 hook 자리만 있고 미사용. `KH` 는 malformed `tool_use` 검출**만** 위해 사용 — `max_tokens`/`refusal`/`pause_turn` 별도 분기 없음 (max_tokens 는 `Fa7(apiError === "max_output_tokens")` 경로). `tombstonePartialThenError` 는 orphan tool_use 블록에 `is_error:true` tool_result 발행. `signal.reason !== "interrupt"` 게이트로 `EHH({toolUse})` interrupt 메시지 (`cV`/`hwH`). |

### Round 2 — 매 턴 주입/실행/체크 (프롬프트·액션·퍼미션)

Round 1이 "루프가 어떻게 굴러가나(제어 흐름)"라면, Round 2는 "한 턴이 굴러갈 때 API로 무엇을 어떻게 실어 보내고, 도구를 어떤 순서로 실행하고, 권한을 언제 어떻게 묻나"의 동적 관점. 정적 조립을 다룬 [`system-prompts.md`](system-prompts.md)·[`permission-system.md`](permission-system.md)와 상보적.

| 문서 | 다루는 범위 | 핵심 발견 |
|---|---|---|
| [`agent-loop-prompt-injection.md`](agent-loop-prompt-injection.md) | `runTurnLoop`가 매 턴 system prompt를 어떻게 빌드/주입하나 — `combineSystemAndContext`/`wrapSystem`, `dynamicBoundaryMarker` cache boundary, 동적 컨텍스트 합류 시점 | 풀 조립 `assembleSystemPrompt`는 `sessionPromptInit`에서 **세션당 1회**. 매 턴 `qH=H4(ca7(q,O))`는 재실행되나 **불변 입력의 얕은 병합**(저비용). CLAUDE.md·날짜·critical reminder 같은 동적 컨텍스트는 **system이 아니라 `makeSystemReminderAttachment` attachment(`<system-reminder>` user 메시지)** 로 주입 → `dynamicBoundaryMarker` 4-breakpoint **캐시 prefix 보존**. compaction(`flattenCompactionResult`)은 messages만 건드리고 system은 turn-invariant. `combineSystemAndContext`/`mergeUserContext`/`resolveUserSystemPrompt` 본문은 추출 누락 → 일부 추정. |
| [`agent-loop-turn-timeline.md`](agent-loop-turn-timeline.md) | 한 턴의 모든 부수효과를 실행 순서대로 (Phase 0/A–E), 13 perf marker + 17 telemetry event 전수 | 20,889자 함수 본문 6 chunk 전수 추출 기반. 각 액션의 fire&forget / awaited / `yield*` 분류. Phase A 셋업 → B 스트리밍 → C 포스트-스트림 결정 → D 도구 실행 → E 턴 클로즈 순서 확정. |
| [`agent-loop-permission-flow.md`](agent-loop-permission-flow.md) | tool_use→실행/거부까지 라이브 콜체인 (`runTurnLoop`→(`dispatchToolBatch`\|`StreamingToolExecutor`)→`runSingleTool`→`checkIsolationLatch`→`executeToolPipeline`→`runPreToolUseHooks`→`decidePermission`→`resolvePermissionDecision`→(`runAutoModeClassifier`\|`canUseTool`)), 6 모드별 동작 | **인터랙티브 prompt는 yield 이벤트가 아님** — 별도 `requestDialog`/`requestPermissionDialog` pub-sub React dialog이고 `executeToolPipeline`은 `await QA6(...)`에서 suspend. 사용자 **"deny" 클릭조차 `behavior:"ask"`로 리턴** → loop은 종료하지 않고 **항상 다음 턴으로 continue**(모델이 거부를 보고 적응). 서브에이전트는 `shouldAvoidPermissionPrompts`로 prompt 우회. |
| [`agent-loop-thinking-effort.md`](agent-loop-thinking-effort.md) | thinking config / reasoning effort / fast mode / max_tokens 결정·주입 | v0.2.8 trigger-word→budget 테이블 **소멸** — `ultrathink`만 생존(budget 숫자 아닌 `ultrathink_effort` attachment). thinking은 `i86`/`MV6`/`Nj9` + `min(max_tokens-1,budget)` clamp. effort는 `EAH` 우선순위(env `CLAUDE_CODE_EFFORT_LEVEL` > opus-4-7 pin > caller > model default), `max`/`xhigh`→`high` **무음 강등** → `output_config.effort`+`RxH` beta. fast는 API `speed:"fast"`(opus-4-6/4-7만, 5조건). effort/fastMode은 **매 턴 재계산**, thinking-type은 세션 고정. `redactThinkingBeta`=redact-thinking beta. |
| [`agent-loop-tools-injection.md`](agent-loop-tools-injection.md) | 매 턴 API에 실리는 tools 배열 — 조립/필터/deferred 제외/MCP pending/tool_choice | tool 조립은 **`callModelOuter`(line 19054) preamble** (K_/19057 아님). `jsonStringify`는 단순 `JSON.stringify`, 실제 serializer는 **`serializeToolsApi`(memoized via `memoizeToolSchema`)**. ToolSearch-deferred tools는 `Xm`/`f` 필터로 제외, **다음 턴** `Pe(H)` 히스토리 스캔으로 재포함(refreshTools 아님). 모든 turn-loop callModel은 **`toolChoice:void 0`**(forced는 auto-mode classifier에만). subagent types는 단일 `Agent` 도구 prompt 내부. loop은 MCP를 **안 기다림**(`hasPendingMcpServers`는 ToolSearch만 살림). |
| [`agent-loop-message-normalization.md`](agent-loop-message-normalization.md) | messages 정규화/변환/userContext 합류 — `sliceAtCompactBoundary`/`replaceOversizedResults`/`mergeUserContext`, `x` 워킹카피 생애 | `sliceAtCompactBoundary`는 **compact_boundary 슬라이스**(필터링 아님). `replaceOversizedResults`/`replaceOversizedImpl`는 200KB(`persistedOutputCap`) per-그룹 tool_result를 **`<persisted-output>` placeholder로 치환**(시크릿/메모리 redaction 아님; `maxResultSizeChars` 무한대 도구 면제). `persistToolResultDualTrack`는 **dual-track**(API엔 트리밍 / 디스크 `.claude/tool-results`+jsonl엔 원본). `mergeUserContext`는 추출 누락 lazy 모듈, callModel 입력 전용 userContext 머지(미저장·추정). `x`는 spread/immutable-rebuild만, **`structuredClone` 미사용**, `D.messages`와 분리 확인. |

읽는 순서 권장: 본 문서 §1–§5 골격 → Round 1(제어 흐름) → Round 2(주입/실행/퍼미션).

### §1–§5 에서 정정된 항목 요약

- **`contextPressureLevel` 레벨**: 3-tier (ok/warn/blocked) → **4-tier** (`ok|warn|compact|blocked`). §3.3 표·§3.7 등 모두 적용.
- **`T_` 버퍼 의미**: §4 표의 "compact/notification 등 다양한 이벤트 누적" 표현은 부정확. 실제로는 **`hint_clears` 전용** — 다른 이벤트는 직접 yield.
- **`FallbackTriggeredError` 발생 조건**: §3.7 본문의 "high-demand 신호" 표현은 부정확. 실제로는 **`qA3=3` 연속 529 + Opus + fallbackModel 셋 다 충족** 시.
- **`post_turn_summary` 의미**: §4 표의 "`runStopHooks`가 시작 표시" 표현은 부정확. 실제로는 **slot reservation 이벤트** — `value:null` 만 yield 되고 실제 내용은 `notifyMetadataChanged` 로 별도 전달.
- **`flattenCompactionResult` 모양**: §3.8 의 "boundary+summary+keep+attachments+hookResults" 는 정확하지만 **한 줄 5-field concat**. 자세한 모양 [`agent-loop-compact-flatten.md`](agent-loop-compact-flatten.md) §2.
- **`dispatchStopHook` 와 `SubagentStop`**: 별도 함수 아님. `dispatchStopHook` 단일이 `agentId` 분기.
- **`Ba7` 식별자**: 본 문서에 등장하지만 v2.1.143 에서 **null** — `isToolUseDeniedMessage` 흐름 자체가 dead code.

### Round 2 에서 정정/확정된 항목

- **system prompt 재조립 비용**: §3·§system-prompts.md 의 "매 턴 ~18 dynamic 섹션 재조립" 뉘앙스는 오해 소지. 풀 조립 `assembleSystemPrompt`는 **세션당 1회(`sessionPromptInit`)**, 매 턴 `qH`는 불변 입력 얕은 병합. 동적 컨텍스트는 system이 아닌 **`<system-reminder>` user 메시지**(`makeSystemReminderAttachment`)로 주입돼 캐시 prefix 보존.
- **`toolChoice`**: §2 의사코드의 `tool_choice:T.toolChoice`는 turn-loop에선 **항상 `void 0`** (forced tool_choice는 auto-mode classifier 전용 별도 호출).
- **deferred tool 가용 시점**: ToolSearch로 deferred tool을 불러도 **그 턴이 아니라 다음 턴**부터 tools 배열에 포함 (`Pe(H)` 히스토리 스캔; `refreshTools` 경로 아님).
- **인터랙티브 권한 prompt**: §4 yield 표에 "permission request UI" 류 이벤트 없음이 맞음 — 권한 prompt는 loop yield가 **아니라** 별도 `requestDialog`/`requestPermissionDialog` React dialog. 사용자 deny 클릭은 `behavior:"ask"`로 환원돼 loop은 종료 없이 다음 턴 진행.
- **trigger-word thinking budget**: v0.2.8의 "think hard/ultrathink → budget 숫자" 매핑은 v2.1.143에서 **제거**. `ultrathink`만 `ultrathink_effort` attachment로 생존.
- **`sliceAtCompactBoundary` 의미**: "hook_progress 필터/tombstone 제거" 추정은 부정확. `sliceAtCompactBoundary`는 **compact_boundary 기준 슬라이스**.
- **`replaceOversizedResults` 의미**: "시크릿 redaction / `[[memory]]` 확장" 추정은 부정확. 200KB 초과 tool_result를 **`<persisted-output>` placeholder로 치환**하는 것이 주 역할 (원본은 디스크 dual-track).
