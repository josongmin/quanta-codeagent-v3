# L1 — HIGH findings

검증 상태 범례는 [README.md](README.md) 참조. 경로는 repo root 기준. CRITICAL은 없음.

---

## 🟠 HIGH

### H1. 스트리밍 대기 중 도착한 사용자 취소(abort)가 `aborted`가 아니라 `error`/`failed`로 오분류
- **위치:** [src/agent/loop.ts:638-645](../../../../src/agent/loop.ts#L638-L645) (+ [recovery.ts:113](../../../../src/agent/recovery.ts#L113), [retry.ts:168-172](../../../../src/agent/retry.ts#L168-L172), [stop-category.ts:189](../../../../src/agent/stop-category.ts#L189), [llm/adapters/anthropic.ts:173-179](../../../../src/llm/adapters/anthropic.ts#L173-L179))
- **카테고리:** race-cancellation · **상태:** [확인됨] · **LIVE**
- **근거:** chunk를 `await`하는 *도중* `config.signal`이 abort되면(=chunk 경계가 아닌 대기 중 Ctrl+C/Esc, 흔한 경우) anthropic 어댑터의 `for await`이 SDK AbortError를 잡아 `LLMError{kind:"aborted"}`로 rethrow한다. `RetryingLLM.stream`은 `isRetryable("aborted")=false`라 그대로 전파 → `streamConsume`의 catch(loop.ts:638)가 `isSessionApprovalRequiredError`만 재던지고 **나머지는 전부 `{error, message}` 반환**(644-645, abort 분기 없음 — 소스 확인). `streamingTurn`의 협조적 `isAborted(signal)` 검사는 `next()` *성공 후*에만 돌기 때문에 `for await` 자체가 throw하면 건너뛰어져 `{kind:"aborted"}`를 반환할 기회가 없다. 이후 `decideOnStreamError`가 `classifyLLMError("aborted")="fatal"` → `{do:"error"}` → `applyAction`이 `{kind:"error"}` TurnResult 생성 → `runTurn` 즉시 반환. `runTurn` 상단의 `if(config.signal.aborted) return {kind:"aborted"}`는 *다음* 이터레이션 진입 시에만 도는데 error는 `done:true`로 즉시 반환되어 재도달 못 함. `resolveTurnLoopOutcome`엔 abort 분기가 없어 `reason:"error"`로 처리, message `"Anthropic stream error: ..."`는 `classifyErrorReason` 어떤 패턴에도 안 맞아 `RUNTIME_UNKNOWN_ERROR`로 떨어짐.
- **영향:** 사용자가 모델 스트리밍 중 취소하면 `AgentOutcome.reason`이 `"aborted"`가 아니라 `"error"`, `stopCategory`가 `interruptedCategory("user")`가 아니라 `{kind:"failed", reasonCode:RUNTIME_UNKNOWN_ERROR}`. **의도적 취소가 런타임 장애로 집계** → 메트릭·트라이아지·재시도 정책 오염.
- **수정:** `streamConsume` catch에서 `isSessionApprovalRequiredError` 재던지기 옆에 abort 분기 추가 —
  ```ts
  if (config.signal.aborted || (e instanceof LLMError && e.kind === "aborted")) {
    samplingStatus = "error"
    return { aborted: true }
  }
  ```
  또는 `decideOnStreamError`가 abort-kind를 `{do:"aborted"}` 신규 액션으로 라우팅. 최소한 `classifyErrorReason`에 abort 마커 분기를 추가해 interrupted 카테고리로 매핑.

### H2. budget_exhausted가 tool 산출 턴 끝에서 트립하면 tool_use는 wm에 남고 대응 tool_result는 유실 → transcript 불균형
- **위치:** [src/agent/loop.ts:1408-1411](../../../../src/agent/loop.ts#L1408-L1411), [2296-2316](../../../../src/agent/loop.ts#L2296-L2316) (+ [budget/meter.ts:188](../../../../src/agent/budget/meter.ts#L188))
- **카테고리:** correctness-bug · **상태:** [확인됨] · **LIVE**
- **근거:** `applyAction`의 proceed 분기가 assistant 메시지(tool_use 블록 포함)를 먼저 `wm.append(message)`(loop.ts:1408, 소스 확인)한 뒤 `{kind:"tools", resultBlocks}`를 반환한다. 그 TurnResult로 `resolveTurnLoopOutcome`이 `recorder?.turn()` 후 `checkExhausted()`(2297)를 검사하는데, exhausted면 resultBlocks를 wm에 넣는 **line 2316 도달 전에** `{kind:"finish", reason:"budget_exhausted"}` 즉시 반환(2298-2306, 소스 확인). `BudgetMeter.checkExhausted`는 `observed > dial`이라 `maxTurns:1`이면 turn 2에 트립 — 그 turn 2가 tool 턴이면 tool_use는 wm에 있고 tool_result는 append 안 됨. `finishAgentSession`이 `wm.snapshot()`을 최종 messages로 persist. 기존 `loop-budget-integration.test.ts:194-206`(3 tool_use, maxTurns:1)은 `messages.length > 0`만 단언하고 균형은 안 봐서 가려짐.
- **영향:** 최종 `messages`가 matching `tool_result` 없는 `tool_use`로 끝나는 불균형 transcript. 이 state로 resume하면 Anthropic 등 provider가 "tool_use ids without tool_result" 400으로 거부 → **resume/fork 깨짐**. completed/refusal 경로는 tool_use 없어 무영향.
- **수정:** exhaustion 검사를 resultBlocks append 뒤로 옮기거나, exhaustion finish 직전에 transcript를 닫는다 —
  ```ts
  if (exhausted?.exhausted) {
    if (args.result.kind === "tools") args.wm.append({ role: "user", content: args.result.resultBlocks })
    emitBudgetExhaustedDecision(...)
    return { kind: "finish", reason: "budget_exhausted", ... }
  }
  ```
  회귀 테스트로 `loop-budget-integration`에 tool_use↔tool_result 균형 단언 추가.

### H3. addTodos/updateTodos가 `todo.phaseId`만 쓰고 대상 phase의 `todoIds`는 갱신 안 함 — 양방향 멤버십 불일치
- **위치:** [src/agent/plan/mutations.ts:218-238](../../../../src/agent/plan/mutations.ts#L218-L238) (addTodos), [317-355](../../../../src/agent/plan/mutations.ts#L317-L355) (updateTodos via [applyPatch:285-313](../../../../src/agent/plan/mutations.ts#L285-L313))
- **카테고리:** correctness-bug · **상태:** [확인됨] · **LIVE**
- **근거:** `addTodos`는 phase 존재를 검증(line 221)하고 `buildTodoItem`으로 `phaseId`를 todo에 박지만, `newPlan = { ...plan, version:+1, todos:newTodos, updatedAt }`(232-237, 소스 확인)이 `plan.phases`를 **그대로 둠** → 새 id가 `phase.todoIds`에 안 들어간다. `updateTodos`도 동일: `applyPatch`가 `phaseId`를 todo에 쓰지만(292-298) 리듀서가 `plan.phases`를 안 건드려, phaseId를 set/move(A→B)해도 B.todoIds에 추가도, A.todoIds에서 제거도 안 됨. 반면 `createPlan`(157-175)·`removeTodos`(382-385)·`fromSnapshot`(snapshot.ts:219-227)은 `phase.todoIds`를 authoritative로 다룸 → 관계의 두 방향을 서로 다른 리듀서가 관리하다 drift.
- **영향:** `addTodos`/`updateTodos` 후 todo가 `phaseId=P`라 주장하는데 `P.todoIds`엔 없음. `phase.todoIds`로 순회하는 소비자가 오렌더. CLI panel([plan-panel.ts:118-124](../../../../src/apps/cli/plan-panel.ts#L118-L124))은 orphan-fallback으로 미배치(ungrouped, phase 밑이 아니라 맨 뒤) 표시라 부분 방어. **phaseId 이동 A→B는 더 나쁨**: stale id가 A.todoIds에 남아 옮긴 todo가 옛 phase 밑에 렌더. orphan-fallback 없는 surface(export, IDE/Tauri, ordered execution)는 todo를 phase에서 통째로 누락. 스냅샷이 손상을 invisibly round-trip(fromSnapshot은 todoIds→todos만 검증, todos→todoIds는 안 함).
- **수정:** `addTodos`에서 빌드 후 각 새 id를 매칭 `phase.todoIds`에 append(phases 재구성). `updateTodos`/`applyPatch`에서 phaseId 변경(null 클리어 포함) 시 옛 phase에서 제거·새 phase에 추가. 또는 `phase.todoIds`를 `todos[*].phaseId`에서 파생하는 view로 만들고 독립 저장 폐지.

### H4. 동시 terminal push가 단일 `resolveProducerWait` 슬롯을 덮어써 parent-abort 시 채널 deadlock
- **위치:** [src/agent/streaming-boomerang/default-streamer.ts:73, 86-92, 106-116, 213-238](../../../../src/agent/streaming-boomerang/default-streamer.ts#L106-L238)
- **카테고리:** race-cancellation · **상태:** [검증됨 — verifier 재현] · **LATENT (default-OFF, unwired)**
- **근거:** `makeClosableChannel`이 producer waiter를 정확히 하나만 보유(`let resolveProducerWait: (()=>void)|null`). `pushInternal`은 slot이 차면 거기 park한다. terminal을 push하는 경로가 둘(producer body의 done/fail, `onParentAbort` 리스너). 재현된 시나리오: producer가 `p1`을 enqueue(slot 채움)하고 둘째 push `p2`에서 park(`resolveProducerWait=R1`) → parent abort → `onParentAbort`가 `pushTerminal` 재진입, slot still full + `cancelledCtrl` 미abort라 또 park(`resolveProducerWait=R2`, **R1 clobber**) → `onParentAbort`가 `channel.cancel()` 동기 호출 → `wakeProducer()`가 R2만 resolve. R1(producer의 `p2` push)은 영영 안 풀림. `cancel()`은 `cancelledCtrl`만 abort하고 `closedCtrl`은 안 건드림 → producer의 `finally{ channel.close() }` 도달 못 함 → consumer `take()`가 `resolveConsumerWait`에 영구 park. verifier가 repro 테스트로 consumer `for await` hang(600ms timeout) 확인.
- **영향:** parent-signal 취소가 chunk in-flight 중 도착하면 producer·consumer 둘 다 deadlock → `cleanup()`의 `await producerSettled` hang → zombie turn + leaked async frame. 이 슬라이스가 봉인 주장하는 바로 그 "abort 후 자원 누수" 클래스(HELL-SB-04/05/12/15). 기존 HELL-SB-12는 progress chunk를 park시킨 채 둘째 terminal을 경합시키지 않아 놓침. **현재 default-OFF**(어떤 caller도 `defaultStreamer`를 안 배선) → 라이브 영향 0이나, **parent-driven cancellation이 이 슬라이스의 헤드라인 기능**이라 첫 배선 시 바로 물린다.
- **수정:** 단일 `resolveProducerWait`를 FIFO 리스트로 교체, `wakeProducer()`/`cancel()`/`close()`가 전부 drain. 또는 terminal push를 직렬화해 최대 1개 producer만 park. 또는 `cancel()`이 `closedCtrl`도 abort해 stuck producer의 leak이 consumer `take()`를 풀게.
