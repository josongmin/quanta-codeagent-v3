# L1 — MEDIUM / LOW findings + Cross-cutting themes

검증 상태 범례는 [README.md](README.md) 참조. 경로는 repo root 기준. 대부분 adversarial verifier 통과.

---

## 🟡 MEDIUM

### M1. refusal 단축경로가 동시성-안전하지만 *mutating*인 tool의 side effect를 실행
- **위치:** [src/agent/streaming-dispatch.ts:499-514, 301-305](../../../../src/agent/streaming-dispatch.ts#L499-L514)
- **카테고리:** correctness-bug · **상태:** [검증됨] · **LIVE**
- **근거:** `scheduleResolvedCall`이 `isConcurrencySafe(name,input)===true` + barrier 미engaged면 호출을 in-flight early-start(`slot.promise=dispatch(call)`). "concurrency-safe"는 "read-only"와 직교인데 [automation_update.ts:86-88](../../../../src/tool/automation_update.ts#L86-L88)·[session_config.ts:211-212](../../../../src/tool/session_config.ts#L211-L212)가 둘 다 `isReadOnly:false` + `isConcurrencySafe:true`. refusal 단축(`if(stopReason!=="refusal")`, L509)은 Phase 3(deferred slot)만 스킵 — 주석 스스로 인정: "Phase 2 already settled the concurrency-safe overlap calls that pre-started — we cannot un-start those." 즉 provider의 `refusal`이 오기 *전에* 스트리밍 끝난 `automation_update`(schedule create/cancel/pause)·`session_config`(set_effort)가 dispatch되어 mutation이 landing.
- **영향:** 거부된 턴이 영속 automation schedule·session effort를 변경. "거부 의도는 실행 금지" 불변식(ADR-0076 Gap-5)이 concurrency-safe tool에선 깨짐. 현재 2개 tool로 좁지만 `isConcurrencySafe && !isReadOnly` 조합이 어디서도 fence 안 됨 → surface가 조용히 성장.
- **수정:** early-start를 read-only AND concurrency-safe일 때만(`registry.isReadOnly`를 `scheduleResolvedCall`에 전달), 또는 tool 계약에서 `isConcurrencySafe()===true ⇒ isReadOnly()===true`를 registration 시 assert.

### M2. refusal 경로가 orphan tool_use 블록을 working memory에 영속화 (게다가 주석이 거짓 불변식 단언)
- **위치:** [src/agent/streaming-dispatch.ts:506-508, 523](../../../../src/agent/streaming-dispatch.ts#L506-L508), [loop.ts:1246-1252](../../../../src/agent/loop.ts#L1246-L1252), [llm/assemble.ts:111-112](../../../../src/llm/assemble.ts#L111-L112)
- **카테고리:** correctness-bug · **상태:** [검증됨] · **LIVE**
- **근거:** streaming-dispatch 주석은 "`runStep`은 error 시 wm.append 안 함 → orphan tool_use가 다음 턴으로 안 넘어감"이라 단언하지만 **refusal은 error 경로가 아님**. `decideOnAssembled`가 `stopReason==="refusal"`에 `{do:"refusal"}` 반환([recovery.ts:133-134](../../../../src/agent/recovery.ts#L133-L134)) → `applyNonSuccessRecoveryAction`의 refusal 전용 분기가 `wm.append(success.message)`(loop.ts:1246-1248)를 terminal 반환 전에 실행. refusal에선 deferred slot이 dispatch 안 돼(Phase 4가 `s.promise!==undefined` 필터, L523) resultBlocks에 그 tool_result가 없는데, `message.content`(assembleFromEvents가 tool_use_start마다 tool_use 블록 push)엔 그 orphan tool_use가 그대로 남음.
- **영향:** refusal이 현재 run은 종료시키지만 orphan tool_use가 영속 wm에 들어감 → resume/fork/replay가 invalid message sequence 재생 → provider 400 거부. 주석이 의존하는 load-bearing 불변식이 실재하지 않음. (H2와 동일 실패모드, 다른 경로.)
- **수정:** refusal 경로에서 un-dispatched orphan tool_use를 `message.content`/`success.message`에서 제거, 최소한 거짓 불변식 주석 정정.

### M3. proactive 압축 서킷브레이커가 기록만 되고 강제 안 됨 (dead abort 분기)
- **위치:** [src/agent/loop.ts:739-906](../../../../src/agent/loop.ts#L870) (maybeCompact, check 누락), [compaction-breaker.ts:132-141](../../../../src/agent/compaction-breaker.ts#L132-L141) (도달불가 proactive abort)
- **카테고리:** correctness-bug · **상태:** [검증됨] · **LIVE**
- **근거:** `maybeCompact`가 `breaker?.recordProactive(before,after)`(loop.ts:870)로 strike만 쌓고 `breaker.check()`를 안 부름. `breaker?.check()`는 reactive PTL recovery action([loop.ts:1261](../../../../src/agent/loop.ts#L1261)) 단 한 곳. proactive abort 분기는 reactive PTL이 동시에 터질 때만 도달. breaker는 default-ON([loop.ts:2374-2376](../../../../src/agent/loop.ts#L2374-L2376))이고 `maxNoProgressProactive`는 assembly([runner/assemble/compaction.ts:37-39](../../../../src/runner/assemble/compaction.ts#L37-L39))로 plumb됨 → proactive 경로에서 아무것도 안 하는 knob. 유일한 integration 테스트([breaker-e2e.test.ts](../../../../tests/integration/breaker-e2e.test.ts))가 reactive만 커버.
- **영향:** proactive(over-threshold) 압축이 반복적으로 진전 없을 때(예: 거대 file read/tool output이 retained suffix에 박힘) "auto-compaction disabled for the session" 동작이 안 켜짐. 세션 내내 매 턴 summarizer LLM 헛호출 → 비용·지연 낭비(행/무한루프 아님 — 턴당 1회 압축, reactive PTL이 overflow 안전망).
- **수정:** `maybeCompact`에서 `compactIfNeeded` 전에 breaker 검사 — `if (breaker?.check().abort) { emitRecovery(config,"compact","breaker-disabled"); return }`. reactive를 mirror하는 proactive no-progress integration 테스트 추가.

### M4. mutator-adapter `updateMeta`가 비원자적 — meta 변경은 커밋됐는데 짝 reorder 실패
- **위치:** [src/agent/plan/mutator-adapter.ts:161-187](../../../../src/agent/plan/mutator-adapter.ts#L161-L187)
- **카테고리:** correctness-bug · **상태:** [검증됨] · **LIVE**
- **근거:** `updateMeta`가 `update_plan` 한 번을 `store.updateMeta` + `store.reorderPhases` 두 store mutation으로 쪼갬. 첫 호출이 이미 version bump + `onDelta` 발화([state.ts:101-107](../../../../src/agent/plan/state.ts#L101-L107)). 둘째가 실패(bad `phaseOrder`의 phase_not_found/duplicate_id)하면 `{ok:false}` 반환 — 그런데 meta mutation은 비가역 커밋됨. 주석도 인정: "if reorderPhases fails, the meta change still landed."
- **영향:** await/return 경계를 넘는 계약 위반. 도구층은 `{ok:false}`로 전체 실패 보고하지만 store version은 +1, observer는 이미 meta delta 수신. caller의 캐시 `expectedVersion`이 stale → **다음 mutation에서 헛 version_conflict**.
- **수정:** meta 적용 전 `phaseOrder`를 현재 phases에 대해 검증, 또는 `updateMetaAndReorder` 단일 리듀서로 전부 검증 후 한 번에 커밋. 최소한 실패 결과에 version bump를 노출해 caller가 resync.

### M5. runTurn throw(HITL approval 등) 경로에서 turn-diff endTurn / git-directive flush / work-metrics 전부 누락
- **위치:** [src/agent/loop.ts:2484-2502, 2522-2532](../../../../src/agent/loop.ts#L2484-L2532) (+ [host/runtime/internal/context-binding.ts:636-646, 939-947](../../../../src/host/runtime/internal/context-binding.ts#L636-L646))
- **카테고리:** silent-error · **상태:** [검증됨] · **LIVE (관측 only)**
- **근거:** `executeTurnWithObservability`가 `turnDiffSession.startTurn(turn)` 후 `runTurn`에서 예외 escape 시 `catch(e){ turnSpanStatus="error"; throw e }`로 rethrow. `flushTurnObservability`(endTurn + gitDirectiveCollector.flush + emitWorkMetrics)는 `runAgentTurnLoop` 정상 반환 *뒤*(2523)에만 호출 → throw 시 스킵. `runAgentInner` finally는 `diagnosticsHook.dispose`만, 외곽 `runAgent` catch도 span만 마킹 후 rethrow. escape 경로 확인: `streamConsume`이 `isSessionApprovalRequiredError`를 재던짐 → `RuntimeApprovalRequiredError`로 host가 잡아 approvalPlaceholderOutcome 반환(HITL pause = 의도된 throw). anchor는 closure-local Map이라 cross-session 영구누수는 아니나, 해당 턴의 `turn_diff_updated` 이벤트·git-directive flush·work-metrics emit은 영구 유실.
- **영향:** HITL approval로 턴이 pause될 때마다(또는 비-LLMError escape 시) 그 턴의 git-diff 이벤트·git-directive·work-metrics가 조용히 사라짐. approval은 흔한 재진입 경로라 관측 데이터가 체계적으로 빠짐. 제어흐름·resume correctness엔 무영향.
- **수정:** turn-diff `endTurn`/`gitDirectiveCollector.flush`/`emitWorkMetrics`를 `executeTurnWithObservability`의 `finally`(turnSpan close 근처)로 이동, 또는 try를 flush까지 감싸 정상·예외 양 경로 모두 수행.

### M6. requiresFeedback HITL 게이트를 gated phase 건너뛰기로 우회 가능
- **위치:** [src/agent/n-phase/default-driver.ts:155-177](../../../../src/agent/n-phase/default-driver.ts#L155-L177)
- **카테고리:** correctness-bug · **상태:** [검증됨] · **LATENT (driver unwired)**
- **근거:** `transition()`이 `requiresFeedback`를 SOURCE phase(`currentSpec`, line 156)에서만 검사, cursor와 target 사이 phase는 안 봄. `cursorChain` fixture: `plan`(idx2, allowSkip:true) → `breakdown`(idx4)가 `feedback`(idx3, requiresFeedback:true)를 점프. skip 분기(164-170)는 `currentSpec.allowSkip`만 게이트 → `{from:"plan",to:"breakdown",direction:"skip"}` 반환, feedback의 필수 게이트 미충족. **[n-phase-hellgate.test.ts:155-165](../../../../tests/unit/agent/n-phase-hellgate.test.ts#L155-L165) (HELL-NP-08)가 이걸 성공으로 박제** — 구멍을 테스트가 보증.
- **영향:** "requiresFeedback phase는 통과 전 승인 수집 필수" 불변식이 선행 phase에 `allowSkip:true`가 하나라도 있으면 무력화. 단 `createDefaultNPhaseDriver`가 현재 UNWIRED(n-phase/ 내부·자체 docs에서만 참조, 어떤 composition root도 미생성) → model-only slice, 라이브 HITL 경로 미우회. driver 배선 시 활성.
- **수정:** skip 분기에서 `specs[cursor+1 .. targetIdx-1]`를 순회, `requiresFeedback && !ledger.has(spec.id)`인 중간 spec이 있으면 `feedback-required` throw. HELL-NP-08를 gated phase를 안 넘게 재작성 + skip-over-gated를 reject하는 hellgate 추가.

---

## 🔵 LOW

### L1. cap-reminder 텍스트가 image/document content 블록 반환 tool에서 유실
- **위치:** [src/agent/dispatch.ts:328-335, 746-749](../../../../src/agent/dispatch.ts#L328-L335) (+ [llm/anthropic-messages-codec.ts:38](../../../../src/llm/anthropic-messages-codec.ts#L38), [tool/image/compose.ts:44-46](../../../../src/tool/image/compose.ts#L44-L46))
- **카테고리:** correctness-bug · **상태:** [검증됨] · **LIVE**
- **근거:** `execute()`가 `resultBlock(call.id, output, !ok, contentBlocks)` 설정(ADR-0126 배열형, images/documents 있으면 채워짐). ADR-0062 cap enforcer 트립 시 `prependCapReminder`가 `...out.block`로 contentBlocks는 그대로 통과시키면서 `<system-reminder>`는 STRING `content`에만 prepend. Anthropic codec이 `content: structuredContent.length>0 ? structuredContent : block.content`라 contentBlocks 있으면 string(과 reminder)을 wire에서 드롭. contentBlocks 안 leading text 블록은 그대로.
- **영향:** image/document 반환 + cap 트립 tool에서 cap-as-instruction reminder가 모델이 읽는 것에서 조용히 누락(UI/preview엔 보임). 멀티모달 경로에서 enforcement no-op.
- **수정:** `prependCapReminder`에서 `out.block.contentBlocks`가 있으면 `{type:"text", text:"<system-reminder>…"}`를 contentBlocks 머리에 prepend(또는 leading text 블록에 splice).

### L2. turn span / work-metrics / activeTurnRef의 turnId 3중 분기로 관측 상관 깨짐
- **위치:** [src/agent/loop.ts:2479-2481, 2122-2123](../../../../src/agent/loop.ts#L2479-L2481) (+ [session-resources.ts:148](../../../../src/agent/session-resources.ts#L148))
- **카테고리:** code-smell · **상태:** [적대적-미검증] · **LIVE**
- **근거:** `executeTurnWithObservability`가 span turnId를 `activeTurnRef?.current.currentTurn?.turnId ?? crypto.randomUUID()`(2480), `buildWorkMetricsResources`가 별도 `workTurnId` 생성(2479), `setActiveTurnHeader`가 또 다른 turnId — 같은 턴에 세 식별자.
- **영향:** span·work-metrics·active-turn 관측치가 서로 다른 turnId라 correlation 불가. 관측 only.
- **수정:** 턴 진입 시 turnId 하나 생성해 셋에 공유.

### L3. runAgentInner throw 경로에서 `activeTurnRef.current.currentTurn`이 non-null·isInterrupted:false로 누수
- **위치:** [src/agent/loop.ts:2119-2130, 2052-2057, 2609-2618, 2361](../../../../src/agent/loop.ts#L2119-L2130)
- **카테고리:** race-cancellation · **상태:** [검증됨 low] · **LATENT (실패 경로 미입증)**
- **근거:** `setActiveTurnHeader`가 매 턴 `activeTurnRef.current={currentTurn:makeTurnHeader(...), isInterrupted:false}` 설정. `currentTurn:null` 복원은 `finishAgentSession`(2052-2057)뿐. throw 시 finish 미호출, finally는 dispose만, 외곽 catch는 rethrow만. `createRunAgentContext` clone이 shallow(`{...baseCfg}`)라 `activeTurnRef`는 caller 원본과 공유.
- **영향:** 턴 도중 예외 escape(approval-required 등) 시 ref가 non-null·비인터럽트로 남아, 같은 ref 재사용 host가 종료/pause된 턴을 "활성"으로 오인 가능. host가 throw 후 같은 ref로 steering/conversation-action 시도해야 관측됨.
- **수정:** `runAgentInner` finally에서 `activeTurnRef`를 `{currentTurn:null, ...}`로 리셋, 또는 외곽 catch도 finish 정리 루틴을 타게.

### L4. PlanStore.restore가 CAS·version 단조성 우회, delta 미발화
- **위치:** [src/agent/plan/state.ts:171-176](../../../../src/agent/plan/state.ts#L171-L176)
- **카테고리:** correctness-bug · **상태:** [검증됨 low] · **LATENT (host 전용 경로)**
- **근거:** `restore: (snap) => { const r=fromSnapshot(snap); if(!r.ok) return r; plan=r.value; return {ok:true} }`. expectedVersion 검사·version 비교·`emit()` 전부 없음. `fromSnapshot`은 `version<0`만 거부.
- **영향:** 옛 snapshot restore가 새 live plan을 조용히 덮어쓰고 version을 낮은 값으로 리셋(emit된 delta 대비 non-monotonic). delta 미발화라 observer desync. restore가 privileged host-driven 경로(clear()와 동급)라 low.
- **수정:** restore 시 synthetic delta emit으로 observer resync, 그리고/또는 expectedVersion 받아 stale restore 거부, 그리고/또는 "observer가 live version 보유 중엔 restore 금지" 명시.

### L5. error-routing classifier/router + metric 포트가 완전한 dead slot이며, 배선 시 활성화되는 latent 라우팅 버그 3개 보유
- **위치:** [src/agent/retry.ts:40, 229, 241-246, 264](../../../../src/agent/retry.ts#L241-L246), [error-routing/default-classifier.ts:91-92, 137](../../../../src/agent/error-routing/default-classifier.ts#L137), [error-routing/default-router.ts:59-67](../../../../src/agent/error-routing/default-router.ts#L59-L67)
- **카테고리:** dead-code · **상태:** [검증됨] · **LATENT (전체 unwired)**
- **근거:** 어떤 production 사이트도 `errorRouting`을 `new RetryingLLM(...)`에 전달 안 함(assemble/llm.ts:101·assemble/compaction.ts:68·repl.ts:168 전부 누락) → `routerForbidsRetry`는 항상 `false`. metric `recordClassified`/`recordAction`은 call site 0, `wireNewSlices`도 미호출. 숨은 latent 버그 3: (1) `swap-fallback` 결정(5xx)이 `routerForbidsRetry`의 rethrow set(abort/hitl)에 없어 `isRetryable`로 → server_error는 `true` → 같은 inner provider에 maxRetries(4) backoff 후에야 FallbackLLM 진행 = "swap now" 의도가 same-provider backoff로 silent downgrade; (2) `LLMError{aborted}` → `activeTurnNotSteerable` → `hitl`이라 의도적 취소가 "surface to human"으로 라우팅; (3) `ToolInputError extends QuantaError`(NOT ToolExecutionError)라 classifier line 137 `instanceof ToolExecutionError` 빗나가 step6 internalServerError → swap-fallback로 caller-bug/400을 "다른 provider 시도"로 오라우팅.
- **영향:** 오늘 0 — non-load-bearing. 위험: 슬롯이 활성처럼 보여(config 필드 존재, RetryingLLM이 읽음, metric이 wire-new-slices에 "wired") 미래 작성자가 `cfg.errorRouting` 배선 시 3 버그를 한 번에 상속, 특히 #1이 hard 5xx 중 dead provider에 수십 초(4×~15s) 낭비.
- **수정:** (a) slice를 deferred/experimental로 명시(doc + unwired assert 테스트), 또는 (b) 배선 시 셋 동시 수정: `routerForbidsRetry`가 `swap-fallback`도 rethrow, abort/cancellation arm을 hitl과 분리, `instanceof ToolInputError → badRequest`를 step6 전에. metric `recordClassified/recordAction`도 호출.

### L6. run-ledger `touch()`가 terminal status 허용 — settle 우회 + error 미캡처 경로
- **위치:** [src/agent/run-ledger/store.ts:98, 234-246](../../../../src/agent/run-ledger/store.ts#L98)
- **카테고리:** solid-violation · **상태:** [검증됨] · **LATENT (live matcher가 도달 차단)**
- **근거:** `applyTouch`가 `RUN_STATUS`의 아무 status(terminal 3개 포함)나 수용(line 98). `start("a")` 후 `touch("a",{status:"completed"})`가 error undefined로 `completed` 반환 — settle와 별개 terminalization 경로, failed에 `opts.error` 캡처 없음. (완화: line 241이 evictIfOverCap 호출, line 239 terminal 가드로 re-touch 차단 → 완전 silent/resurrection은 아님.)
- **영향:** touch와 settle 간 계약 불일치 foot-gun. live 경로 미트리거: default matcher가 `touch.status`를 `running|waiting`으로만 타입([run-ledger-attribution/types.ts:42](../../../../src/agent/run-ledger-attribution/types.ts#L42)), subscriber가 유일 런타임 caller. 미래 직접 caller에만 영향.
- **수정:** `applyTouch`가 `running`/`waiting`만 수용, terminal은 무시하고 terminalization은 `settle`로 일원화.

### L7. run-mode `compactionTokenThreshold`가 trigger인데 ceiling으로 min-clamp (방향 반대)
- **위치:** [src/agent/run-mode/clamp.ts:36, 52-65](../../../../src/agent/run-mode/clamp.ts#L36) (+ [budget/types.ts:54-55](../../../../src/agent/budget/types.ts#L54-L55))
- **카테고리:** correctness-bug · **상태:** [검증됨] · **LATENT (현재 inert)**
- **근거:** `compactionTokenThreshold`가 `DIAL_FIELDS`(clamp.ts:36)에 있어 `resolveDial`의 `min(requested,cap)` 적용. 자체 doc(budget/types.ts:54)은 "Compaction trigger token threshold (advisory)"라 budget ceiling이 아님 — trigger에 min은 방향 반대(clamp down하면 압축이 더 일찍 발화). 현재 inert: 어떤 BUDGET_PRESET도 안 set([presets.ts:145-211](../../../../src/agent/run-mode/presets.ts#L145-L211)), caps=presets라 cap 항상 undefined → request 그대로.
- **영향:** latent. 어떤 mode cap이 `compactionTokenThreshold`를 set하는 순간 caller의 "늦게 압축" 요청을 조용히 낮춰 압축 조기 발화 + `[budget-cap]` 오라벨. 나머지 멤버가 전부 진짜 `max*` ceiling인 리스트에 섞여 무의식 도입 쉬움.
- **수정:** `DIAL_FIELDS`에서 제거(진짜 ceiling만 clamp), 또는 별도 threshold-knob 분기에서 `max(requested,cap)` + 별도 로그 라벨.

### L8. guard adapter가 `{block:true, text:undefined}`를 budget 소비 후 silent pass-through 취급
- **위치:** [src/agent/guards/verify-guard.ts:51-61](../../../../src/agent/guards/verify-guard.ts#L51-L61), [guards/closeout-guard.ts:40-41](../../../../src/agent/guards/closeout-guard.ts#L40-L41), [closeout-guard.ts:156-167](../../../../src/agent/closeout-guard.ts#L156-L167), [verify-guard.ts:134-139](../../../../src/agent/verify-guard.ts#L134-L139)
- **카테고리:** code-smell · **상태:** [검증됨] · **LATENT (현재 도달불가)**
- **근거:** `decideCloseoutGuard`가 block-return 전 `state.trips+=1`(line 156), `decideVerifyGuard`가 block arm에서 `spendTrip` 호출. adapter가 `if(!verdict.block || verdict.text===undefined) return undefined`로 게이트 → `{block:true, text:undefined}`가 budget 소비 *후* pass-through. 현재 도달불가 확인: closeout는 line 156 이후 3개 exit이 전부 text 동반(159/164/167), verify는 모든 spendTrip이 text와 paired(186/191).
- **영향:** latent. `{block:true}`만 반환하는 미래 정책 refactor가 nudge 주입도 block도 없이 guard의 one-shot budget(closeout)/trip(verify)을 소진 → 세션 내내 그 guard 무력화(0 신호). 추가로 verify-guard PASS 분기가 phantom-pass에서 `onVerifySuccess` 발화(non-verified state에서 shadow-ODB anchor 전진).
- **수정:** "block:true엔 항상 text" 불변식을 구조적으로 강제 — 결과 객체를 두 필드와 함께 atomic 생성, 또는 adapter가 실제 block 확정 후에만 trip 소비.

---

## Cross-cutting themes

1. **조기 종료 경로의 transcript/outcome 무결성 붕괴 (최우선).** H1(abort) · H2(budget) · M2(refusal) 셋 다 정상 경로는 멀쩡한데 *조기 종료* 시 wm에 orphan tool_use를 남기거나 reason을 오태깅한다. resume/fork/replay를 ship하는 코드베이스라 직접적 위험. → "조기 종료 시 wm 닫기 + outcome 정규화" 공용 헬퍼 한 패스로 동시 차단 권장.

2. **양방향 관계를 서로 다른 리듀서가 관리하다 drift.** H3(plan todoIds ↔ phaseId) · L6(touch ↔ settle terminalization). 한쪽만 갱신하는 mutation이 불변식을 깬다. → 파생 view화 또는 단일 리듀서로 양방향 atomic 갱신.

3. **default-OFF / unwired slice의 latent 함정.** H4 · M6 · L4·L5·L7·L8이 전부 "지금은 도달 안 되지만 배선 시 활성." seam 철학이 폭발 반경을 막아주지만, 슬롯이 *활성처럼 보여서* 미래 작성자가 버그를 상속한다(특히 L5 error-routing, H4 streaming-boomerang). → unwired slice에 "deferred/experimental" 명시 doc + unwired-assert 테스트.

4. **관측성이 예외/조기 경로에서 조용히 빠짐.** M5(throw 시 flush 누락) · L2(turnId 분기). 제어흐름엔 무해하나 메트릭·trace가 체계적으로 결손. → flush를 finally로, turnId 단일 소스화.
