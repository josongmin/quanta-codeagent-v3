# Bq3 — 한 턴의 완전한 시간순 액션 시퀀스

추출 위치: [`extracted-functions.js:14057`](../../extracted-functions.js#L14057) — 단일 라인 20,889자 `async function*`.

본 문서는 [agent-loop.md](agent-loop.md) (제어 흐름 골격) 의 보강으로, **한 턴 진입부터 다음 턴 진입까지** 실행되는 **모든 부수효과 / ctx 변이 / state 쓰기 / 텔레메트리·perf 마커 / yield** 를 함수 본문에서 추출한 정확한 실행 순서대로 번호 매겨 나열한다. 재구현자가 라인 단위로 따라갈 수 있는 "실제로 무슨 일이 일어나는가" 타임라인이다.

표기: minified id 는 `백틱`. `확인` = 함수 본문에서 직접 검증됨. `추정` = 호출처/명명 기반 추론. fire&forget / awaited / yield 여부를 각 액션마다 명시.

---

## Phase 0 — 함수 진입 (루프 밖, 1회만)

`while(!0)` 진입 **전에** 단 1회 실행 (확인):

| # | 액션 | 종류 | 효과 |
|---|---|---|---|
| 0.1 | `H` 디스트럭처 | sync | `systemPrompt:q, userContext:K, systemContext:O, canUseTool:T, fallbackModel:$, querySource:z, spawnedBySkill:A, maxTurns:Y, skipCacheWrite:w, forkPointUuid:j` 로 분해 |
| 0.2 | `J = H.deps ?? Sa7()` | sync | deps 객체 확정. `Sa7()` = `{callModel:NiH, microcompact:pt, autocompact:Ia7, uuid:crypto.randomUUID, now:()=>ISO}` (확인) |
| 0.3 | `D = {...}` 초기화 | sync | turn-carry state. `messages/toolUseContext/maxOutputTokensOverride` 는 `H` 에서, 나머지는 기본값: `compactTracking:undefined, stopHookActive:H.stopHookActive??false, stopHookBlockingCount:0, maxOutputTokensRecoveryCount:0, hasAttemptedReactiveCompact:false, turnCount:1, pendingToolUseSummary:undefined, transition:undefined` (확인) |
| 0.4 | `M=null, f=void 0` | sync | `M` 미사용 슬롯(추정), `f` = taskBudget remaining 누적 캐리 |
| 0.5 | `X = ya7()` | sync | gates 스냅샷 1회. `{sessionId:k_(), gates:{streamingToolExecution:Z_("tengu_streaming_tool_execution2",false), emitToolUseSummaries:env CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES, isAnt:false, fastModeEnabled:!env CLAUDE_CODE_DISABLE_FAST_MODE}}` (확인). **루프 내내 고정** — 매 턴 재평가 안 함 |
| 0.6 | `using P = ga7(D.messages, D.toolUseContext, z)` | sync | ES2026 disposable. memdir prefetch 핸들 또는 `undefined`. dispose 는 `runTurnLoop` **함수 전체 종료 시** (어떤 reason 이든) `[Symbol.dispose]()` → `z.abort()` + `d("tengu_memdir_prefetch_collected",...)` (확인; 자세히는 [agent-loop-memdir-prefetch.md](agent-loop-memdir-prefetch.md)) |

---

## Phase A — 턴 진입 / 셋업

`while(!0)` 본체 매 진입 시 (확인):

| # | 액션 | 종류 | 효과 / 변이 |
|---|---|---|---|
| A.1 | `{toolUseContext:Z} = D` | sync | 이번 턴 ctx 로컬 바인딩 |
| A.2 | `{messages:W, compactTracking:G, maxOutputTokensRecoveryCount:L, hasAttemptedReactiveCompact:k, maxOutputTokensOverride:v, pendingToolUseSummary:E, stopHookActive:h, stopHookBlockingCount:I, turnCount:C} = D` | sync | 9개 turn-carry 필드 로컬 바인딩 |
| A.3 | `m = Uy8?.().startSkillDiscoveryPrefetch(null, W, Z)` | **fire&forget** | skill discovery prefetch 킥오프. `m` = prefetch 핸들 (Phase E 에서 consume). `startSkillDiscoveryPrefetch호출자` 없으면 `undefined` |
| A.4 | `yield {type:"stream_request_start"}` | **yield** | 턴 경계 표식. callModel 이 아닌 Bq3 가 직접, 턴당 1회 (fallback/retry 재진입엔 없음) |
| A.5 | `v5("query_fn_entry")` | sync | perf 마커 #1 |
| A.6 | `if (!Z.agentId) UX("query_started")` | sync | headless profiler 체크포인트. **메인 쿼리만** (서브에이전트 제외). `UX` 는 `R8()&&VM8` 일 때만 `performance.mark` 발행 (확인) |
| A.7 | `p = Z.queryTracking ? {chainId:기존, depth:기존+1} : {chainId:J.uuid(), depth:0}` | sync | queryTracking 체인 파생. 기존 체인이면 depth+1, 신규면 새 uuid+depth0 |
| A.8 | `S = p.chainId` | sync | 이후 모든 텔레메트리의 `queryChainId` 로 쓰임 |
| A.9 | `Z = {...Z, queryTracking:p}` | sync (ctx 변이) | ctx 사본에 새 queryTracking 주입 |
| A.10 | `x = [...ZA(W)]` | sync | 메시지 정규화 사본. `sliceAtCompactBoundary` = 메시지 정규화기 (line 15593) |
| A.11 | `F = G` | sync | compactTracking 로컬 별칭 (`F` 가 이번 턴 동안 갱신됨) |
| A.12 | `g = Z.precomputeSourceKey!==void 0 && F?.compacted!==true && !mD8(z)` | sync | `isPreFirstCompactFork` 플래그 — fork 세션에서 아직 compact 안 됨 |
| A.13 | `Q = z.startsWith("agent:") \|\| z.startsWith("repl_main_thread")` | sync | content-replacement 콜백 활성 조건 |
| A.14 | `x = await cr9(x, Z.contentReplacementState, Q?콜백:undefined, new Set(maxResultSize 무한 도구명))` | **awaited** | contentReplacementState 적용 (대용량 결과 치환). `Q` 면 `YNH(...,agentId).catch(vH)` fire&forget 콜백 전달. `replaceOversizedResults` line 8561 |
| A.15 | `c = 0` | sync | context-token 보정 오프셋 (이번 턴 내내 0 추정 — 변경 코드 없음) |
| A.16 | `v5("query_microcompact_start")` | sync | perf 마커 #2 |
| A.17 | `x = (await J.microcompact(x, Z, z)).messages` | **awaited** | tier1 microcompact. `microcompactNoop` (조용한 시간기반 컷). 결과 messages 로 `x` 교체 |
| A.18 | `r = void 0` | sync | 미사용 슬롯 |
| A.19 | `v5("query_microcompact_end")` | sync | perf 마커 #3 |
| A.20 | `qH = H4(ca7(q, O))` | sync | 시스템 프롬프트 빌드/캐시 (`combineSystemAndContext` = systemPrompt+systemContext 결합, `wrapSystem` = 캐시 wrapper). callModel 에 `systemPrompt:qH` 로 전달 |
| A.21 | `v5("query_autocompact_start")` | sync | perf 마커 #4 |
| A.22 | `{compactionResult:e, consecutiveFailures:HH, consecutiveRapidRefills:o, rapidRefillBreakerTripped:s} = yield* J.autocompact(x, Z, {systemPrompt:q,userContext:K,systemContext:O,toolUseContext:Z,forkContextMessages:x}, z, F, c)` | **yield\*** | tier2 autocompact (`runAutocompact` generator). 진행 이벤트(compact_progress/sdk_status/notification/response_length) 를 yield\* 로 그대로 흘림 |
| A.23 | `v5("query_autocompact_end")` | sync | perf 마커 #5 |
| A.24 | **IF `s` (rapidRefillBreakerTripped)** | — | (A.24a~c) |
| A.24a | `d("tengu_auto_compact_rapid_refill_breaker", {consecutiveRapidRefills:F?.consecutiveRapidRefills??0, turnsSincePreviousCompact:F?.turnCounter??-1, queryChainId:S, queryDepth:p.depth})` | sync 텔레메트리 | rapid-refill 차단 기록 |
| A.24b | `T_ = y1({content:gy8, error:"invalid_request", now:J.now, uuid:J.uuid})` → `yield T_` | **yield** | `rapidRefillBreakerMsg` = "Autocompact is thrashing..." ApiErrorMessage |
| A.24c | `pJH(Z,z,T_)` → **return `{reason:"rapid_refill_breaker"}`** | fire&forget + return | API failure 영속화. `runStopFailureHook` 호출 안 함 (확인) |
| A.25 | **ELSE IF `e` (compactionResult 존재)** | — | (A.25a~f) |
| A.25a | `{preCompactTokenCount,postCompactTokenCount,truePostCompactTokenCount,compactionUsage} = e` 디스트럭처; `J_ = m0(model, effort)` | sync | 텔레메트리 페이로드 준비 |
| A.25b | `d("tengu_auto_compact_succeeded", {originalMessageCount:W.length, compactedMessageCount:summary+attachments+hookResults 길이, effort_level?, preCompactTokenCount, postCompactTokenCount, truePostCompactTokenCount, compaction*Tokens 5종, queryChainId:S, queryDepth})` | sync 텔레메트리 | compact 성공 메트릭 |
| A.25c | **IF `H.taskBudget`**: `B_ = RA8(x)`; `f = Math.max(0, (f??H.taskBudget.total) - B_)` | sync (state) | taskBudget remaining 재계산 (절대값 — 누적 아님) |
| A.25d | `F = {compacted:true, turnId:J.uuid(), turnCounter:0, consecutiveFailures:0, consecutiveRapidRefills:o}` | sync (state) | compactTracking 새로 구축 |
| A.25e | `b_ = AKH(e)`; `for (B_ of b_) yield B_` | **yield (다수)** | compact 결과 5종 평탄화([agent-loop-compact-flatten.md](agent-loop-compact-flatten.md) §2.1) 를 그 자리에서 모두 yield |
| A.25f | `x = b_` | sync | messages 를 평탄화 결과로 교체 |
| A.26 | **ELSE IF `HH!==void 0` (consecutiveFailures)** | sync (state) | `F = {...F??{compacted:false,turnId:"",turnCounter:0}, consecutiveFailures:HH}` — 실패 카운트만 갱신 |
| A.27 | **IF `b47({compactionResult:e, consecutiveFailures:HH, hasAttemptedReactiveCompact:k, lastTransitionReason:D.transition?.reason, isReactiveFallbackEnabled:Nw_(), isPreFirstCompactFork:g, contextTokens:Wf(x,...)-c, model, autoCompactWindow})`** → `x47({querySource:z, messages:x, cacheSafeParams:{...}})` | sync 판정 + **fire&forget** | precomputed-compact 백그라운드 시작 (조건 충족 시). `startPrecomputeFork` 는 await 안 됨 — 백그라운드 요약 미리 생성 |
| A.28 | `Z = {...Z, messages:x, turnStartIndex:Uq3(x)}` | sync (ctx 변이) | ctx 에 정규화/compact 적용된 messages + 마지막 진짜 user 인덱스(`lastTurnBoundaryIndex`) 주입 |
| A.29 | `wH=[], JH=[], _H=[], t=false, KH=null` | sync | 턴 누적기 초기화: collectedAssistant / collectedToolResults / pendingToolUses / sawToolUse / latestStopReason |
| A.30 | `v5("query_setup_start")` | sync | perf 마커 #6 |
| A.31 | `TH = X.gates.streamingToolExecution ? new gX_(Z.options.tools, T, Z) : null` | sync | streaming tool exec 컨테이너 (게이트 ON 시) |
| A.32 | `zH = Z.getAppState()` | sync | 앱 상태 스냅샷 (mcp.tools/mcp.clients/advisorModel 사용) |
| A.33 | `jH = Z.getToolPermissionContext().mode` | sync | 현재 permission mode |
| A.34 | `$H = iZ({permissionMode:jH, mainLoopModel:Z.options.mainLoopModel, exceeds200kTokens:jH==="plan"&&Y_6(x)})` | sync | 모델 ID 해석 — plan 모드 + 200k 초과 시 opusplan/haiku swap. `$H` = 실제 호출 모델 |
| A.35 | `v5("query_setup_end")` | sync | perf 마커 #7 |
| A.36 | `fH = X.gates.isAnt && Z7H(z)!=="auxiliary" ? Y57(Z.agentId??X.sessionId) : void 0` | sync | fetchOverride (isAnt 환경 전용; 기본 false 이므로 보통 undefined) |
| A.37 | `GH = false` | sync | 죽은 분기 플래그 (변경 코드 없음 — 확인) |
| A.38 | `kH = Nw_() && r0() && !oiH(Z.options.mainLoopModel, Z.getAutoCompactWindow())` | sync | reactive-fallback 활성 & autocompact 켜짐 & 자동 윈도우 커스텀 아님 → true 면 blocking 사전체크 스킵 |
| A.39 | **IF `!e && z!=="compact" && !kH && !GH`**: `if (zNH(Wf(x,rZ(model))-c, model, autoCompactWindow).level==="blocked")` | sync 판정 | context blocking-limit 검사 (compact 직후/`/compact`/reactive활성 제외) |
| A.39a | `d("tengu_ptl_surfaced_to_user", {reason:"blocking_limit", querySource:dJ(z), wasGatedByPriorAttempt:false})` | sync 텔레메트리 | (blocked 일 때만) |
| A.39b | `H_ = y1({content:wg, error:"invalid_request", now,uuid})` → `yield H_` | **yield** | `blockingLimitMsg` = "Prompt is too long" (확인) |
| A.39c | `pJH(Z,z,H_)` → **return `{reason:"blocking_limit"}`** | fire&forget + return | `runStopFailureHook` 호출 안 함 |
| A.40 | **IF `u4H && G7() && z.startsWith("repl_main_thread") && !Z.agentId`** | — | markTurnActive 블록 |
| A.40a | `T_ = x.findLast(user && !isMeta && content가 string)` | sync | 마지막 평문 user 메시지 탐색 |
| A.40b | `u4H().markTurnActive(riH(), x0(), T_?.content ?? undefined)` | **fire&forget** (app-state 쓰기) | repl 메인스레드 한정 — UI 에 "턴 활성" + 사용자 입력 텍스트 마킹 |

---

## Phase B — 모델 스트리밍

| # | 액션 | 종류 | 효과 |
|---|---|---|---|
| B.1 | `DH = true` | sync | inner-loop "모델 다시 실행" 플래그 |
| B.2 | `v5("query_api_loop_start")` | sync | perf 마커 #8 (outer try 직전, 1회만) |
| B.3 | `try { while(DH) { DH=false; ...` | — | inner 재시도 루프 (모델 fallback 전용) |
| B.4 | `T_ = []` | sync | hint_clears pending 버퍼 (매 inner iteration 새로) |
| B.5 | `try { H_=false, G_=[], M_=[]` | sync | onStreamingFallback 플래그 / backfill 패치쌍 / image-error deferred 버퍼 |
| B.6 | `v5("query_api_streaming_start")` | sync | perf 마커 #9 |
| B.7 | `for await (J_ of J.callModel({messages:aY6(x,K), systemPrompt:qH, thinkingConfig, tools, signal:Z.abortController.signal, options:{...}}))` | **awaited 스트림** | callModel 호출. options 에 `model:$H`, `fallbackModel:$`, `onStreamingFallback:()=>{H_=true}`, `onHintCleared:(...)=>{...}`, `maxOutputTokensOverride:v`, `taskBudget:{total, remaining:f}` 등 전달 |
| | | | **onHintCleared 콜백** (callModel 내부 동기 호출 시): `T_.push({type:"hint_clears", ids, contentById})`; `for (l_ of fi9(x,b_)) Z.readFileState.delete(H9(l_))` (ctx 변이 — staleness 무효화); `x = Nz_(x,b_,B_)` (messages 리매핑) |
| B.8 | (스트림 이벤트마다, 순서대로) | — | (B.8a~g) |
| B.8a | `if (T_.length>0) yield* T_, T_.length=0` | **yield\*** | iteration 시작 시 hint_clears flush |
| B.8b | **IF `H_` (onStreamingFallback)**: `for (l_ of wH) yield {type:"tombstone",message:l_}`; `d("tengu_orphaned_messages_tombstoned",{orphanedMessageCount:wH.length, queryChainId:S, queryDepth})`; `wH=[]/JH=[]/_H=[]/G_=[]/t=false`; `if(TH){TH.discard(); TH=new gX_(...)}` | **yield(다수)+텔레메트리+state리셋** | non-stream fallback — 받은 partial 전부 무효화 |
| B.8c | `b_ = J_` (기본); **IF `J_.type==="assistant"`**: content 순회하며 `tool_use` 의 `backfillObservableInput` 적용 → 신규 키 추가 시 lazy copy, `b_={...J_,message:{...content:l_}}`, `G_.push({src:J_.message, dst:b_.message})` | sync (메시지 가공) | observable input 보강 패치본 생성 |
| B.8d | **IF `J_.type==="stream_event" && event.type==="message_delta"`**: `KH = delta.stop_reason`; `for ({src,dst} of G_) dst.usage/stop_reason/stop_details = src.*`; `G_.length=0` | sync (state) | latestStopReason 캡처 + 패치본에 usage 역주입 |
| B.8e | `B_=false; if(r47(J_))B_=true; if(rD8(J_))B_=true,M_.push(J_); if(Fa7(J_))B_=true; if(!B_){ if(M_.length>0) yield* M_,M_=0; yield b_ }` | **yield (조건부)** | PTL/image/max_output_tokens 오류 메시지는 yield 보류; 정상이면 image-deferred flush 후 패치본 yield |
| B.8f | **IF `J_.type==="assistant"`**: `wH.push(J_)`(원본); `l_=tool_use 필터`; `if(l_.length>0) _H.push(...l_),t=true`; `if(TH&&!aborted) for(p_ of l_) TH.addTool(p_,J_)` | sync (state) + fire&forget(TH.addTool 가 비동기 도구 실행 킥) | collectedAssistant/pendingToolUses 누적, streaming exec 등록 |
| B.8g | **IF `TH&&!aborted`**: `for (l_ of TH.getCompletedResults())`: `if(dm(l_)){yield l_;continue}`; `if(l_.message){ yield l_.message; if(!_P_(l_.message)){ p_=i0([l_.message],refreshTools()??tools,model); y$_(p_,mA(model).maxBase64Size); JH.push(...p_.filter(user)) }}}` | **yield(다수)+state** | streaming 도구 완료 결과 회수 → bridge 이벤트는 그대로, message 는 yield 후 i0/y$_ 후처리하여 JH 누적 |
| B.9 | (스트림 종료 후) `v5("query_api_streaming_end")`; `if(T_.length>0) yield* T_,T_=0` | sync 마커 #10 + **yield\*** | 잔여 hint_clears flush |
| B.10 | `catch(H_)` (inner): `if(T_.length>0) yield* T_,T_=0` | **yield\*** | 에러 시 hint flush |
| B.10a | **IF `H_ instanceof ANH && $`** (모델 fallback): `$H=$; DH=true; for(G_ of wH) yield {type:"tombstone",message:G_}; wH/JH/_H=0,t=false; if(TH){TH.discard();TH=new gX_(...)}; Z.options.mainLoopModel=$` (ctx 변이); `EH("model_fallback")` (텔레메트리 성공 플래그); `d("tengu_model_fallback_triggered",{original_model,fallback_model:$,entrypoint:"cli",queryChainId:S,queryDepth})`; `yield VO("Switched to ${nM(fb)} due to high demand for ${nM(orig)}","warning")`; **`continue`** (inner while 재진입 — 같은 턴, 새 모델) | yield+텔레메트리+state+continue | turnCount 증가 없음, D 불변 |
| B.10b | **ELSE** `throw H_` | — | outer catch 로 전파 |
| B.11 | `catch(T_)` (outer): `H_ = T_ instanceof Error ? T_.message : String(T_)`; `d("tengu_query_error",{assistantMessages:wH.length, toolUses:wH.flatMap(tool_use).length, queryChainId:S, queryDepth})` | sync 텔레메트리 | |
| B.11a | **IF `T_ instanceof mUH \|\| T_ instanceof iF`** (이미지 크기 오류): `N("Query image error...",error)`; `M_=y1({content:T_.message,error:"invalid_request",errorDetails,now,uuid})`; `yield M_`; `pJH(Z,z,M_)`; **return `{reason:"image_error"}`** | yield+fire&forget+return | |
| B.11b | **ELSE**: `vH(T_)` (로그); `yield* Ua7(wH,H_,J)` (미완료 tool_use 에 가짜 is_error tool_result yield); `G_=y1({content:H_,now,uuid})`; `yield G_`; `pJH(Z,z,G_)`; `ux("Query error",T_)`; **return `{reason:"model_error",error:T_}`** | yield\*+yield+fire&forget+return | |

---

## Phase C — 스트림 후 결정

스트림 정상 종료 후 (확인, 실행 순서대로):

| # | 액션 | 종류 | 효과 |
|---|---|---|---|
| C.1 | `if (wH.some(text 중 ma7(text)))` → `d("tengu_model_response_keyword_detected",{is_suggests_break:true, queryChainId:S, queryDepth})` | sync 텔레메트리 | `detectBreakKeyword` = `/\bgo to (sleep\|bed)\b/` 검출 (확인) — "suggests break" |
| C.2 | `if (wH.length>0) T57([...x,...wH], q,K,O,Z,z)` | **fire&forget** | `persistTranscript` = transcript persist hook 배열(`lj5`) 순회 실행. 각 hook `await z($)` 하지만 `persistTranscript` 자체는 await 안 됨(추정 — `for...of` + 내부 try). 페이로드 `{messages,systemPrompt,userContext,systemContext,toolUseContext,querySource}` |
| C.3 | **IF `Z.abortController.signal.aborted`** (스트리밍 중 중단) | — | (C.3a~e) |
| C.3a | `if(TH) for await(T_ of TH.getRemainingResults()){ if(dm(T_)){yield T_;continue} if(T_.message) yield T_.message }` **else** `yield* Ua7(wH,"Interrupted by user",J)` | **yield(다수)** | 남은 streaming 결과 흘리거나 가짜 tool_result |
| C.3b | `if(!Z.agentId) await eRH(Z).catch(()=>{})` | **awaited** (fire&forget catch) | 메인 쿼리 한정 — abort 정리(eRH) |
| C.3c | `if(signal.reason!=="interrupt") yield EHH({toolUse:false,now,uuidFn})` | **yield (조건부)** | interrupt 아닌 abort 시 안내 메시지 |
| C.3d | `mJH(Z,z)` | fire&forget (app-state) | markTurnAborted |
| C.3e | **return `{reason:"aborted_streaming"}`** | return | |
| C.4 | **IF `E` (이전 턴 pendingToolUseSummary)**: `T_=await E; if(T_) yield T_` | **awaited + yield(조건부)** | 직전 턴이 시작한 PostTurnSummary 도착 시 yield. null 이면 yield 안 함 |
| C.5 | **IF `!t` (tool_use 없음)** | — | (C.5 ~ C.11; 종료/재시도 결정 블록) |
| C.5a | `T_=wH.at(-1)`; `H_ = T_?.assistant && T_.isApiErrorMessage && OGH(T_)` (PTL/413); `M_ = !(Ba7!==null && ...) && rD8(T_)` (image) | sync 판정 | `Ba7`=null 이므로 deny-check dead code (확인) |
| C.6 | **IF `H_ \|\| M_`** (PTL 또는 image 오류) | — | reactive compact 블록 |
| C.6a | `b_=Qy8(F)` (rapid-refill 카운트); **IF `!k && b_>=oY6`(=3)**: `d("tengu_auto_compact_rapid_refill_breaker",{...,reactive:true})`; `__=y1({content:gy8,...})`; `yield __`; `pJH(Z,z,__)`; **return `{reason:"rapid_refill_breaker"}`** | 텔레메트리+yield+fire&forget+return | |
| C.6b | `B_=performance.now()` (ptlDetectedAt); `l_ = H_&&T_ ? FUH(T_) : void 0` (initialTokenGap) | sync | |
| C.6c | `{swap:p_, emittedEarlyCompactStart:u_} = yield* rY6(__=>u47({toolUseContext:__, messages:x, isWithheld413:H_, hasAttemptedReactiveCompact:k, borrowFrom:g?Z.precomputeSourceKey:void 0, ptlDetectedAt:B_, querySource:z}), Z)` | **yield\*** | reactive phase A (precomputed swap 시도) — 진행 이벤트 흘림 |
| C.6d | `c_ = yield* rY6(__=>o47({hasAttempted:k, querySource:z, aborted:signal.aborted, messages:x, cacheSafeParams:{...,toolUseContext:__,forkContextMessages:x}, precomputed:p_, userWaitStartedAt:B_, initialTokenGap:l_}), Z)` | **yield\*** | reactive phase B (사용자-대기 동기 요약) |
| C.6e | **IF `c_` (compactResult)**: taskBudget 재계산(`f`); `__=AKH(c_); for(a of __) yield a`; `F={compacted:true,turnId:J.uuid(),turnCounter:0,consecutiveFailures:0,consecutiveRapidRefills:b_}`; `D={messages:__, toolUseContext:Z, compactTracking:F, maxOutputTokensRecoveryCount:L, hasAttemptedReactiveCompact:p_===void 0, maxOutputTokensOverride:void 0, pendingToolUseSummary:void 0, stopHookActive:h, stopHookBlockingCount:0, turnCount:C, transition:{reason:p_?"precomputed_compact_swap":"reactive_compact_retry"}}`; **`continue`** | yield(다수)+state+continue | turnCount 유지. `hasAttemptedReactiveCompact = swap===undefined` |
| C.6f | **IF `u_` (emittedEarlyCompactStart)**: `yield {type:"compact_progress",event:{type:"compact_end"}}`; `yield {type:"sdk_status",status:null}` | **yield** | early compact_start 발행했으면 짝 맞춰 닫음 |
| C.6g | `WH = M_?"image_error":"prompt_too_long"`; `CH=z==="compact"`; `if(!aborted && !CH) d("tengu_ptl_surfaced_to_user",{reason:WH, querySource:dJ(z), wasGatedByPriorAttempt:k})`; `yield T_`; `$NH(T_,Z)`; `pJH(Z,z,T_)`; **return `{reason:WH}`** | 텔레메트리+yield+fire&forget(StopFailure hook + API fail)+return | |
| C.7 | **IF `Fa7(T_)`** (apiError==="max_output_tokens") | — | (C.7a~b) |
| C.7a | **IF `L<mq3`(=3)**: `b_=D6({content:"Output token limit hit. Resume directly — no apology...", isMeta:true, now, uuidFn})`; `D={messages:[...x,...wH,b_], toolUseContext:Z, compactTracking:F, maxOutputTokensRecoveryCount:L+1, hasAttemptedReactiveCompact:k, maxOutputTokensOverride:void 0, pendingToolUseSummary:void 0, stopHookActive:h, stopHookBlockingCount:0, turnCount:C, transition:{reason:"max_output_tokens_recovery",attempt:L+1}}`; **`continue`** | state+continue (yield 없음 — D.messages 에만 주입) | |
| C.7b | **ELSE** `yield T_` | **yield** | 3회 초과 — 원본 에러 surface (이후 C.8/C.9/C.10 으로 fallthrough) |
| C.8 | **IF `(T_?.message.stop_reason ?? KH)==="tool_use" && _H.length===0 && !T_?.isApiErrorMessage`** (malformed tool_use) | — | (C.8a~c) |
| C.8a | `b_ = D.transition?.reason!=="malformed_tool_use_retry"`; `d("tengu_malformed_tool_use_response",{will_retry:b_, model:$H})` | sync 텔레메트리 | |
| C.8b | **IF `b_` (첫 시도)**: `l_=D6({content:"Your tool call was malformed and could not be parsed. Please retry.", isMeta:true, now, uuidFn})`; `yield l_`; `D={messages:[...x,...wH,l_], ..., maxOutputTokensRecoveryCount:0, hasAttemptedReactiveCompact:false, ..., turnCount:C, transition:{reason:"malformed_tool_use_retry"}}`; **`continue`** | yield+state+continue | |
| C.8c | **ELSE** (재시도도 실패): `B_=y1({content:"The model's tool call could not be parsed (retry also failed)."})`; `yield B_`; `$NH(B_,Z)`; `pJH(Z,z,B_)`; **return `{reason:"completed"}`** | yield+fire&forget+return | |
| C.9 | **IF `T_?.isApiErrorMessage`**: `if(u4H&&riH()&&G7()&&repl_main_thread&&!agentId){ b_=rE(T_)??""; await u4H().markApiFailure(riH(),x0(),T_.error,b_) }`; `$NH(T_,Z)`; `pJH(Z,z,T_)`; **return `{reason:"completed"}`** | awaited(app-state)+fire&forget+return | |
| C.10 | `J_ = yield* Va7(x, wH, q,K,O, Z, z, h, riH())` | **yield\*** | Stop/SubagentStop hooks (+goal eval). active_goal/goal_status/post_turn_summary 등 yield |
| C.10a | `if (I>0 && J_.blockingErrors.length===0) d("tengu_stop_hook_block_count",{count:I, is_subagent:Boolean(Z.agentId), hit_max_turns:false, hit_cap:false})` | sync 텔레메트리 | 이전에 차단되었다가 풀린 경우 기록 |
| C.10b | **IF `J_.preventContinuation`**: **return `{reason:"stop_hook_prevented"}`** | return | (mJH/pJH/$NH 호출 없음 — 확인) |
| C.10c | **IF `J_.blockingErrors.length>0`**: `b_=C+1; B_=I+1`; **IF `Y&&b_>Y`**: `d("tengu_stop_hook_block_count",{count:B_,...,hit_max_turns:true})`; `yield T9({type:"max_turns_reached",maxTurns:Y,turnCount:b_})`; **return `{reason:"max_turns",turnCount:b_}`** | 텔레메트리+yield+return | |
| C.10d | `l_=parseInt(env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP??"",10); p_=isNaN?8:l_`; **IF `p_>0 && B_>p_`**: `d("tengu_stop_hook_block_count",{count:B_,...,hit_cap:true})`; `yield VO("A hook blocked the turn from ending ${B_} consecutive times — overriding...","warning")`; **return `{reason:"completed"}`** | 텔레메트리+yield+return | (mJH/pJH/$NH 없음) |
| C.10e | **ELSE**: `D={messages:[...x,...wH,...J_.blockingErrors], toolUseContext:Z, compactTracking:F, maxOutputTokensRecoveryCount:0, hasAttemptedReactiveCompact:k, maxOutputTokensOverride:void 0, pendingToolUseSummary:void 0, stopHookActive:true, stopHookBlockingCount:B_, turnCount:b_, transition:{reason:"stop_hook_blocking"}}`; **`continue`** | state+continue | turnCount **증가**(b_=C+1), stopHookActive=true |
| C.11 | (위 분기 모두 미해당) **return `{reason:"completed"}`** | return | 정상 종료 (tool_use 없고 Stop hook 통과) |

---

## Phase D — 도구 실행

`!t` 가 false (즉 tool_use 있음) 인 경우만 진입 (확인):

| # | 액션 | 종류 | 효과 |
|---|---|---|---|
| D.1 | `NH=false, yH=false, dH=Z` | sync | hookStopped / hookDeferred 플래그, 변이가능 ctx 로컬 `dH` |
| D.2 | `v5("query_tool_execution_start")` | sync | perf 마커 #11 |
| D.3 | `if(TH) d("tengu_streaming_tool_execution_used",{tool_count:_H.length, queryChainId:S, queryDepth})` **else** `d("tengu_streaming_tool_execution_not_used",{...})` | sync 텔레메트리 | streaming exec 사용 여부 |
| D.4 | `gH = TH ? TH.getRemainingResults() : Hj_(_H, wH, T, Z)` | sync (async iterable) | streaming 잔여 vs 비-streaming 배치 디스패처 |
| D.5 | `for await (T_ of gH)` | **awaited 스트림** | (D.5a~e 매 결과마다) |
| D.5a | `if(dm(T_)){yield T_;continue}` | **yield(조건부)** | bridge 이벤트는 그대로 |
| D.5b | `if(T_.message){ yield T_.message; ...}` | **yield** | tool_result 메시지 |
| D.5c | `if(attachment.type==="hook_stopped_continuation") NH=true; if("hook_deferred_tool") yH=true` | sync (state) | hook 종료/지연 신호 캡처 |
| D.5d | `if(!_P_(T_.message)){ H_=i0([T_.message], dH.options.refreshTools?.()??dH.options.tools, model); y$_(H_,mA(model).maxBase64Size); JH.push(...H_.filter(user)) }` | sync (state) | virtual 제외 → i0 expand → base64 검증 → JH 누적 |
| D.5e | `if(T_.newContext) dH={...T_.newContext, queryTracking:p}` | sync (ctx 변이) | 도구가 ctx 수정했으면 전파 (queryTracking 보존) |
| D.6 | `v5("query_tool_execution_end")` | sync | perf 마커 #12 |
| D.7 | `let rH;` | sync | PostTurnSummary promise 슬롯 |
| D.8 | **IF `X.gates.emitToolUseSummaries && _H.length>0 && !aborted && !Z.agentId`** | — | (D.8a~c) |
| D.8a | `T_=wH.at(-1)`; 마지막 text block 추출 → `H_`(lastAssistantText) | sync | |
| D.8b | `G_=_H.map(id)`; `M_=_H.map(name/input/output)` — `JH` 에서 tool_result content 매칭 | sync | summary 입력 구성 |
| D.8c | `rH = t47({tools:M_, signal, isNonInteractiveSession, lastAssistantText:H_}).then(J_=>J_?da7(J_,G_):null).catch(()=>null)` | **fire&forget (promise 저장)** | PostTurnSummary 백그라운드 시작; 다음 턴 `pendingToolUseSummary` 로 carry |

---

## Phase E — 턴 종료 / 다음 턴 진입

도구 실행 후 (확인, 순서대로):

| # | 액션 | 종류 | 효과 |
|---|---|---|---|
| E.1 | **IF `Z.abortController.signal.aborted`**: `if(!Z.agentId) await eRH(Z).catch(()=>{})`; `if(signal.reason!=="interrupt") yield EHH({toolUse:true,now,uuidFn})`; `T_=C+1; if(Y&&T_>Y) yield T9({type:"max_turns_reached",maxTurns:Y,turnCount:T_})`; `mJH(Z,z)`; **return `{reason:"aborted_tools"}`** | awaited+yield+fire&forget+return | |
| E.2 | **IF `yH` (hookDeferred)**: `mJH(Z,z)`; **return `{reason:"tool_deferred"}`** | fire&forget+return | |
| E.3 | **IF `NH` (hookStopped)**: `mJH(Z,z)`; **return `{reason:"hook_stopped"}`** | fire&forget+return | |
| E.4 | **IF `_H.length===1 && _H[0].name===az && Hr_(Z.options.mainLoopModel)`**: `T_=_H[0].input.prompt`; `if(zR().some(kind==="loop"&&prompt===T_))`: `d("tengu_loop_dynamic_wakeup_ends_turn",{queryChainId:S,queryDepth})`; `mJH(Z,z)`; `yield* ka7(x,wH,q,K,O,Z,z,h)`; **return `{reason:"completed"}`** | 텔레메트리+fire&forget+yield\*+return | `az`="ScheduleWakeup", `Hr_` 보통 false (확인 — 거의 dead) |
| E.5 | **IF `F?.compacted`**: `F.turnCounter++`; `d("tengu_post_autocompact_turn",{turnId:F.turnId, turnCounter:F.turnCounter, queryChainId:S, queryDepth})` | sync (state)+텔레메트리 | compact 후 경과 턴 카운트 |
| E.6 | `d("tengu_query_before_attachments",{messagesForQueryCount:x.length, assistantMessagesCount:wH.length, toolResultsCount:JH.length, queryChainId:S, queryDepth})` | sync 텔레메트리 | |
| E.7 | **IF `JS("PostToolBatch", dH.getAppState(), dH.agentId??k_())`** | — | (E.7a~f) PostToolBatch hook |
| E.7a | `T_=\`hook-${J.uuid()}\``; `H_=new Map`; `JH` 의 tool_result 를 `H_` 에 `tool_use_id→content` 매핑 | sync | |
| E.7b | `for await (J_ of qP_(_H.map({tool_name,tool_input,tool_use_id,tool_response}), T_, dH, mode, signal))` | **awaited 스트림** | PostToolBatch hook 실행 |
| E.7c | `if(J_.message && !(hook_blocking_error)) yield J_.message` | **yield(조건부)** | |
| E.7d | `if(J_.additionalContexts?.length>0){ b_=T9({type:"hook_additional_context",content,hookName:"PostToolBatch",toolUseID:T_,hookEvent}); yield b_; JH.push(b_) }` | **yield+state** | 추가 컨텍스트 주입 |
| E.7e | `if(J_.blockingError) G_=true,M_??=...; if(J_.preventContinuation) G_=true,M_??=stopReason` | sync (state) | |
| E.7f | **IF `dH.abortController.signal.aborted`**: eRH/EHH/`mJH(dH,z)`; **return `{reason:"aborted_tools"}`** — **IF `G_`**: `yield T9({type:"hook_stopped_continuation",message:M_\|\|"Execution stopped by PostToolBatch hook",...})`; `mJH(dH,z)`; **return `{reason:"hook_stopped"}`** | yield+fire&forget+return | PostToolBatch blocking 은 retry 없이 즉시 종료 |
| E.8 | `aH = z.startsWith("repl_main_thread")\|\|z==="sdk"`; `K_=Z.agentId`; `RH = Z.messageQueue.getCommandsByMaxPriority("next").filter(...)` (Nc9 제외, repl 이면 agentId undefined, 아니면 task-notification+agentId 일치) | sync | 큐 드레인 대상 선별 |
| E.9 | `for await (T_ of SnH(null, dH, null, RH, [...x,...wH,...JH], z)) yield T_, JH.push(T_)` | **awaited 스트림 + yield + state** | messageQueue 드레인 결과 yield & JH 누적 |
| E.10 | `pH = RH.filter(mode==="prompt"\|\|"task-notification")`; **IF `pH.length>0`**: `for(T_ of pH) if(T_.uuid){ _.push(T_.uuid); Z.onCommandLifecycle?.(T_.uuid,"started") }`; `Z.messageQueue.remove(pH)` | sync (lifecycle uuid push + 콜백 + 큐 변이) | 처리된 prompt 큐에서 제거 + caller lifecycle 추적 |
| E.11 | **IF `P && P.settledAt!==null && P.consumedOnIteration===-1`**: `T_=Qa7(await P.promise, Z.readFileState)`; `for(H_ of T_){ G_=T9(H_); yield G_; JH.push(G_) }`; `P.consumedOnIteration=C-1` | **awaited+yield(다수)+state** | memdir prefetch 1회 consume (`transformMemdirResults` 변환) |
| E.12 | **IF `Uy8 && m`**: `T_=await Uy8().collectSkillDiscoveryPrefetch(m)`; `for(H_ of T_){ G_=T9(H_); yield G_; JH.push(G_) }` | **awaited+yield(다수)+state** | skill discovery prefetch 결과 회수 (A.3 에서 킥한 것) |
| E.13 | `UH=H8(JH, type==="attachment"&&attachment.type==="edited_text_file")`; `d("tengu_query_after_attachments",{totalToolResultsCount:JH.length, fileChangeAttachmentCount:UH, queryChainId:S, queryDepth})` | sync 텔레메트리 | |
| E.14 | **IF `dH.options.refreshTools`**: `T_=dH.options.refreshTools()`; `if(T_!==dH.options.tools){ mcp 개수 비교; if(다르면) d("tengu_mcp_tools_refreshed_mid_turn",{oldMcpCount,newMcpCount,recovered}); dH={...dH,options:{...,tools:T_}} }` | sync (ctx 변이)+텔레메트리(조건부) | 도구 핫리로드 |
| E.15 | **IF `dH.options.refreshMcpClients`**: `T_=dH.options.refreshMcpClients()`; `dH={...dH,options:{...,mcpClients:T_}}` | sync (ctx 변이) | MCP 클라이언트 핫리로드 |
| E.16 | `eH={...dH, queryTracking:p}` | sync | 다음 턴 ctx (queryTracking 유지) |
| E.17 | `oH=C+1`; **IF `Y && oH>Y`**: `yield T9({type:"max_turns_reached",maxTurns:Y,turnCount:oH})`; `mJH(Z,z)`; **return `{reason:"max_turns",turnCount:oH}`** | yield+fire&forget+return | |
| E.18 | `v5("query_recursive_call")` | sync | perf 마커 #13 (정상 next_turn 경로 전용) |
| E.19 | `D = {messages:[...x,...wH,...JH], toolUseContext:eH, compactTracking:F, turnCount:oH, maxOutputTokensRecoveryCount:0, hasAttemptedReactiveCompact:false, pendingToolUseSummary:rH, maxOutputTokensOverride:void 0, stopHookActive:h, stopHookBlockingCount:0, transition:{reason:"next_turn"}}` | sync (state) | 다음 턴 D 재할당. `pendingToolUseSummary:rH` (D.8c 의 promise), turnCount **증가** |
| E.20 | (루프 자연 순환 — `continue` 명시 없음) | — | `while(!0)` 재진입 → Phase A.1 |

---

## v5("query_*") perf 마커 카탈로그 (13개, 확인)

| # | 마커 | 트리거 위치 / 조건 |
|---|---|---|
| 1 | `query_fn_entry` | 매 턴 진입, `stream_request_start` yield 직후 (A.5) |
| 2 | `query_microcompact_start` | tier1 microcompact 호출 직전 (A.16) |
| 3 | `query_microcompact_end` | microcompact await 직후 (A.19) |
| 4 | `query_autocompact_start` | tier2 autocompact yield\* 직전 (A.21) |
| 5 | `query_autocompact_end` | autocompact yield\* 직후 (A.23) |
| 6 | `query_setup_start` | gX_/appState/permissionMode/모델swap 셋업 시작 (A.30) |
| 7 | `query_setup_end` | 셋업 끝, blocking-limit 검사 직전 (A.35) |
| 8 | `query_api_loop_start` | inner-while(fallback retry) 진입 직전, **1회만** (B.2) |
| 9 | `query_api_streaming_start` | callModel for-await 진입 직전, 매 inner iteration (B.6) |
| 10 | `query_api_streaming_end` | callModel for-await 종료 직후 (B.9) |
| 11 | `query_tool_execution_start` | tool batch 실행 직전 (D.2) |
| 12 | `query_tool_execution_end` | tool batch 끝 (D.6) |
| 13 | `query_recursive_call` | 정상 next_turn `D={...}` 직전, **정상 경로 전용** (E.18) |

추가 profiler: `UX("query_started")` — `!Z.agentId` 일 때 A.6 에서 1회 (headless profiler `performance.mark`, `v5` 와 별개 채널). `EH("model_fallback")` — ANH fallback 성공 시 텔레메트리 성공-플래그 세터 (B.10a).

---

## d("tengu_*") 텔레메트리 이벤트 카탈로그 (Bq3 내, 확인)

| 이벤트 | 트리거 조건 | 주요 페이로드 |
|---|---|---|
| `tengu_auto_compact_rapid_refill_breaker` | (1) autocompact 가 breaker tripped 리턴 (A.24a), (2) reactive 경로 refill≥3 (C.6a) | `consecutiveRapidRefills, turnsSincePreviousCompact, queryChainId, queryDepth` (+`reactive:true` reactive 경로) |
| `tengu_auto_compact_succeeded` | autocompact compactionResult 존재 (A.25b) | `originalMessageCount, compactedMessageCount, pre/post/truePostCompactTokenCount, compaction*Tokens 5종, effort_level?` |
| `tengu_ptl_surfaced_to_user` | (1) blocking_limit 종료 직전 (A.39a), (2) prompt_too_long/image_error 종료 직전 & `!aborted && z!=="compact"` (C.6g) | `reason("blocking_limit"\|"prompt_too_long"\|"image_error"), querySource:dJ(z), wasGatedByPriorAttempt` |
| `tengu_orphaned_messages_tombstoned` | onStreamingFallback(`H_`) 트리거 시 (B.8b) | `orphanedMessageCount:wH.length, queryChainId, queryDepth` |
| `tengu_model_fallback_triggered` | inner-catch ANH & fallbackModel 존재 (B.10a) | `original_model, fallback_model, entrypoint:"cli", queryChainId, queryDepth` |
| `tengu_query_error` | outer-catch 진입 (B.11) | `assistantMessages:wH.length, toolUses(tool_use 개수), queryChainId, queryDepth` |
| `tengu_model_response_keyword_detected` | assistant text 에 `detectBreakKeyword`("go to sleep/bed") 매칭 (C.1) | `is_suggests_break:true, queryChainId, queryDepth` |
| `tengu_malformed_tool_use_response` | stop_reason="tool_use" + pendingToolUses 0 (C.8a) | `will_retry:boolean, model:$H` |
| `tengu_stop_hook_block_count` | (1) 이전 차단 풀림 `I>0 && blockingErrors=0` (C.10a), (2) maxTurns 초과 (C.10c), (3) cap 초과 (C.10d) | `count, is_subagent, hit_max_turns, hit_cap` |
| `tengu_streaming_tool_execution_used` / `_not_used` | tool 실행 직전, `TH` 유무 (D.3) | `tool_count:_H.length, queryChainId, queryDepth` |
| `tengu_loop_dynamic_wakeup_ends_turn` | 단일 ScheduleWakeup 도구 + loop 매칭 (E.4) | `queryChainId, queryDepth` |
| `tengu_post_autocompact_turn` | `F?.compacted` 일 때 매 턴 끝 turnCounter++ 후 (E.5) | `turnId, turnCounter, queryChainId, queryDepth` |
| `tengu_query_before_attachments` | 매 턴 도구 실행 후 PostToolBatch 직전 (E.6) | `messagesForQueryCount, assistantMessagesCount, toolResultsCount, queryChainId, queryDepth` |
| `tengu_query_after_attachments` | attachment/큐/prefetch flush 후 (E.13) | `totalToolResultsCount, fileChangeAttachmentCount, queryChainId, queryDepth` |
| `tengu_mcp_tools_refreshed_mid_turn` | refreshTools 가 mcp 개수 변경 시 (E.14) | `oldMcpCount, newMcpCount, recovered` |
| `tengu_memdir_prefetch_collected` | `using P` dispose 시 (Bq3 함수 전체 종료, Phase 0.6) | memdir-prefetch.md 참조 |
| `query_started` (via `UX`) | A.6, `!Z.agentId`. (텔레메트리 아닌 profiler mark) | — |

추가 호출 (텔레메트리는 아니나 동일 위치 부수효과): `runStopHooks`/`runPostToolBatchHook`/`dispatchToolBatch`/`StreamingToolExecutor`/`reactiveCompactPhaseB`/`reactiveCompactPhaseA`/`SnH` 내부에 별도 `d("tengu_*")` 다수 — 각 서브문서 참조.

---

## fire&forget vs awaited vs yield 요약

**fire&forget (await 안 함)**:
- `Uy8?.().startSkillDiscoveryPrefetch` (A.3)
- `x47(...)` precomputed compact 백그라운드 (A.27)
- `T57(...)` transcript persist hooks (C.2)
- `mJH(...)` markTurnAborted (C.3d, E.1/E.2/E.3/E.4/E.7f/E.17)
- `pJH(...)` markApiFailure (A.24c, A.39c, B.11a/b, C.6g, C.8c)
- `$NH(...)` StopFailure hook (C.6g, C.8c, C.9)
- `u4H().markTurnActive(...)` (A.40b)
- `t47(...).then(...).catch(...)` PostTurnSummary (D.8c — promise 는 `rH` 에 저장되어 다음 턴 await)
- `Z.onCommandLifecycle?.(...)` (E.10)
- `using P` dispose (함수 종료)

**awaited**:
- `cr9(...)` (A.14)
- `J.microcompact(...)` (A.17)
- `eRH(Z)` abort 정리 (C.3b, E.1, E.7f) — `.catch(()=>{})` 로 swallow
- `E` pendingToolUseSummary (C.4)
- `u4H().markApiFailure(...)` (C.9 — repl 메인스레드 경로에서만 직접 await)
- `await P.promise` memdir (E.11)
- `Uy8().collectSkillDiscoveryPrefetch(m)` (E.12)
- `for await` 스트림: `J.callModel`(B.7), `TH.getRemainingResults`/`dispatchToolBatch`(D.5), `runPostToolBatchHook`(E.7b), `SnH`(E.9)

**yield\* (제너레이터 위임)**:
- `J.autocompact` (A.22)
- inner `T_`/`M_` 버퍼 flush (B.8a/e, B.9, B.10)
- `tombstonePartialThenError` 가짜 tool_result (B.11b, C.3a)
- `rY6(u47)` / `rY6(o47)` reactive compact (C.6c/d)
- `runStopHooks` Stop hook (C.10)
- `ka7` loop-wakeup 정리 (E.4)

---

## 추정 / 확인 필요

- `c` (context-token 보정) 는 `0` 으로 초기화되고 본문 내 재대입 없음 — 항상 0 (확인). 보강 문서 다른 위치에서 의미 부여될 가능성 (추정).
- `M=null`, `r=void 0` 슬롯은 Bq3 본문에서 미사용 — minify 잔재 또는 다른 코드패스 hook 자리 (추정).
- `GH=false` 는 변경 코드 없어 `if(!e&&z!=="compact"&&!kH&&!GH)` 의 `!GH` 는 항상 true — dead 가드 (확인, [agent-loop-compact-flatten.md](agent-loop-compact-flatten.md) §2.3.4 와 일치).
- `Ba7` = null 이므로 C.5a 의 `Ba7!==null` deny-check 항상 false → image 검출은 순수 `rD8(T_)` (확인).
- `persistTranscript` 의 await 경계: `persistTranscript` 함수 자체는 `for(z of lj5) try{ await z($) }` 로 내부적으로 await 하나 Bq3 는 `T57(...)` 결과를 await 안 함 → Bq3 입장에선 fire&forget (`lj5=[]` 비어있어 실질 no-op, 확인).
- `Hr_(model)` 은 보통 false 반환 (loop dynamic wakeup 비활성, [agent-loop-compact-flatten.md](agent-loop-compact-flatten.md) 부록 일치) — E.4 는 거의 도달 안 함 (추정).
