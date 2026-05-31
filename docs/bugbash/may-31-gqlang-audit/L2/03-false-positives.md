# L2 — 오탐 / 강등 기록

> 1라운드 finder가 HIGH로 올렸으나 독립 재검증(Explore agent, 소스 직접 재독)에서 기각/강등. **HIGH 11건 중 5건 완전 오탐 + 1건 부분강등 = 환각률 ~45%.** 적대적 재검증이 없었으면 그대로 신뢰됐을 것 — 이 레인의 가장 큰 교훈.

## FP1. 모드 hard-forbidden surface 미집행 (강등: High → 오탐)

- **원주장(H1):** `deriveIsolatedContext`가 forbiddenSurfaces를 `parentOwned − granted`로만 계산, mode hard-forbidden 미머지 + grant가 금지 해제.
- **검증 결과:** 오탐. **`deriveIsolatedContext` 함수 자체가 코드베이스에 존재하지 않음**(grep -r + git log -S 전이력 확인). 실제 [isolated-context.ts:31-62](../../../../src/agent/subagent-typed/isolated-context.ts#L31)는 `chainParentSignal`/`makeChildCorrelation`만 보유.
- **왜 기각:** `ModeProfile`([port.ts:79](../../../../src/agent/subagent-typed/port.ts#L79))에 forbiddenSurfaces 필드 자체가 없음 — finder가 mode-typed slice와 SubagentRequest slice를 혼동해 **없는 함수를 환각**.

---

## FP2. forbiddenSurfaces 집행 지점 부재 (강등: High → 오탐)

- **원주장(H2):** forbiddenSurfaces가 isolate→runner까지 배선되나 거부 코드 경로 전무, `forbidden-surface` errorKind는 타입만.
- **검증 결과:** 오탐(메커니즘 오인). `DelegateSpec`([types.ts:75](../../../../src/agent/delegation-runner/types.ts#L75))에 forbiddenSurfaces 필드 자체가 없어 "배선됨" 전제가 틀림. forbiddenSurfaces는 [subagent-runner.ts:181](../../../../src/agent/subagent-runner.ts#L181)에서 seed-prompt 텍스트("**Forbidden surfaces** (do NOT touch): ...")로만 사용.
- **왜 기각:** 런타임 강제는 **설계상 부재**(LLM-compliance용 prompt-guardrail). "미구현 결함"이 아니라 의도된 advisory boundary. (강제가 필요하다는 별도 설계논의는 H5 부분확정 참조 — 버그는 아님.)

---

## FP3. spawn_agent depth 캡 미집행 — fork-bomb (강등: High → 오탐)

- **원주장(H4):** dispatch-6가 ToolContext.depth를 parentDepth로 미전달 → 매 spawn depth=1, maxDepth 캡 무력화, fork-bomb.
- **검증 결과:** 오탐. depth 미스레딩은 사실이나 `dispatchSubagent6`는 **export-only dead code**([index.ts:28](../../../../src/subagent/index.ts#L28)에서 export, production 호출처 0). 실제 spawn은 `createAgentTool`이 [agent-tool.ts:136](../../../../src/subagent/agent-tool.ts#L136) `ctxDepth`로 depth 정상 전달 + [agent-tool.ts:367](../../../../src/subagent/agent-tool.ts#L367) maxDepth cap 강제.
- **왜 기각:** finder가 frozen contract surface(ADR-0041 six-tool standard)를 production 경로로 오인. fork-bomb 발현 불가.

---

## FP4. LaneManager running 카운터 underflow (강등: High → 오탐)

- **원주장(H8):** reject 모드 캡 도달 시 `acquireSlot()`가 false 반환하나 `!acquired` early-return이 `finally{releaseSlot()}` 통과 → 미보유 슬롯 release → running 음수.
- **검증 결과:** 오탐(제어흐름 오독). `if (!acquired)` early-return 블록이 try-finally **밖**([default-manager.ts:76](../../../../src/agent/lane-manager/default-manager.ts#L76) acquire, ~:110 미획득 return은 try 진입 전). return이 try 밖이라 finally 미실행 → running 불변.
- **왜 기각:** JS 제어흐름 semantics 오인. (단 **같은 함수의 H9 abort-deadlock은 확정** — 01 참조.)

---

## FP5. forkOnAccept가 fork된 work를 await/track 안 함 (강등: High → 오탐)

- **원주장(H11):** fire-and-forget fork, AbortSignal 미전파, reject가 unhandled.
- **검증 결과:** 오탐. (1) fork()는 SubagentHandleId 반환(handle 기반, 의도된 설계). (2) onAccept 콜백은 `{toolCallId, elapsedMs}`만 받음 — 전파할 parent signal 자체가 없고, 스케줄러가 [subagent-background.ts:481](../../../../src/agent/subagent-background.ts#L481) per-fork AbortController 생성·threading. (3) promise는 entry.promise로 추적, startRun이 모든 경로 try/catch로 감싸 **never-rejects 계약**([subagent-background.ts:447](../../../../src/agent/subagent-background.ts#L447) "Never rejects: every failure path mutates entry.result").
- **왜 기각:** finder가 thin bridge의 책임모델을 오인(bridge는 fork 발사, scheduler가 lifecycle 소유).

---

## FP6(부분강등). 4개 lane 죽은 코드 (강등: High → Low, thread-tools 한정)

- **원주장(H10):** mention-injection/mention-runner/thread-tools/auto-background 전부 importer 0 dead code.
- **검증 결과:** 부분 오탐. **3개는 실제 widely-wired:**
  - mention-injection — 1751+ import (host/runtime, loop-activation-hook 등)
  - mention-runner — [assemble.ts:35](../../../../src/apps/agent/assemble.ts#L35), [mention-wire.ts:30](../../../../src/host/runtime/internal/mention-wire.ts#L30)
  - auto-background — [session-execution-plane.ts:5](../../../../src/runner/session-execution-plane.ts#L5), AgentConfig.autoBackground
- **thread-tools만 진짜 dead code** → 02-medium-low.md의 H10(low)로 강등.
- **왜 기각:** finder가 grep 범위/카운트를 부정확하게 보고.
