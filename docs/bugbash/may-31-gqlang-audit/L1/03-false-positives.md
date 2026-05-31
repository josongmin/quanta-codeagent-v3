# L1 — Rejected false-positives (8 groups)

Finder가 제기했으나 adversarial **verification pass가 소스 재독 후 기각**한 것. 재제기 방지용 기록. 각 항목: 주장 / file:line / *왜 진짜 버그가 아닌지*.

---

## FP-1 · streaming-cancel · "raceIdle degrade가 rejecting source pull을 orphan → unhandledRejection"
- **File:** [src/agent/stream-timeout/default-watchdog.ts](../../../../src/agent/stream-timeout/default-watchdog.ts)
- **Verdict:** false-positive — Promise.race가 핸들
- **Why:** `Promise.race([pending, guard])`는 지는 promise(`pending`) *자신*에 reaction handler를 등록하므로 엔진이 나중 rejection을 handled로 취급. `process.on("unhandledRejection")` probe + late `rejectPull(new Error(...))`로 두 번 재현 시도 → 0 unhandled rejection. 드롭.

## FP-2 · plan · "noop bump가 빈 입력에 version을 올리고 delta를 emit"
- **File:** [src/agent/plan/types.ts:135-138](../../../../src/agent/plan/types.ts#L135-L138)
- **Verdict:** by-design (문서화된 의도)
- **Why:** types.ts:135-138이 명시: "Plan version still bumps so callers can detect 'checked but found no change.'" 빈 입력에도 version bump + delta는 의도된 동작 — "검사했으나 변화 없음"을 caller가 감지하기 위함. 결함 아님.

## FP-3 · runmode-ledger · "objective `set()`이 full-replace라 부분 업데이트 유실"
- **File:** [src/agent/objective/types.ts:84-92](../../../../src/agent/objective/types.ts#L84-L92)
- **Verdict:** by-design
- **Why:** 포트 doc이 `set`을 "(re)initialization" 진입점으로 명명, 별도 update verb 미노출. re-`set`이 cell을 재초기화하는 게 문서화된 계약. finder 본인 evidence도 "there is no separate update method"로 trail off. 결함 아님.

## FP-4 · compaction-recovery · "defaultStopReasonPolicy의 `max_tokens → surface` override가 정상 종료를 깨뜨림"
- **File:** [src/agent/stop-reason/default-policy.ts](../../../../src/agent/stop-reason/default-policy.ts)
- **Verdict:** invalid (unwired, opt-in by design)
- **Why:** `stopReasonPolicy`는 어떤 composition root도 안 배선(default-OFF, opt-in, 문서화). override 시맨틱은 opt-in caller를 위한 의도. 라이브 종료 경로 미영향.

## FP-5 · compaction-recovery · "reactive PTL breaker가 squeeze 전 미검사"
- **File:** [src/agent/loop.ts:1261](../../../../src/agent/loop.ts#L1261), [compaction-breaker.ts](../../../../src/agent/compaction-breaker.ts)
- **Verdict:** false-positive — 올바르게 가드됨
- **Why:** `check()`가 squeeze *전*에 돌고 `recordReactive`는 *후*에 돈다. e2e + hellgate 커버. (proactive 경로의 미강제는 별개 — M3로 분리 보고.) reactive 경로엔 결함 없음.

## FP-6 · compaction-recovery · "recovery FSM / stop-policy default-policy가 에러를 삼킴"
- **File:** [src/agent/recovery.ts](../../../../src/agent/recovery.ts), [stop-reason/default-policy.ts](../../../../src/agent/stop-reason/default-policy.ts)
- **Verdict:** false-positive
- **Why:** 순수 함수 + exhaustive switch, swallow 없음. 결함 아님.

## FP-7 · compaction-recovery · "microcompact compactor 버그"
- **File:** [src/agent/microcompact/compactor.ts](../../../../src/agent/microcompact/compactor.ts)
- **Verdict:** invalid (dead path)
- **Why:** unwired default-OFF slice(테스트에서만 사용). 프로젝트 컨벤션상 dead path. 라이브 결함 아님.

## FP-8 · side-interrupt · 후보 일괄 (drift-warning 미주입 / `Math.random` sid / abort-after-last-event)
- **File:** [src/agent/focus-chain/drift-detector.ts](../../../../src/agent/focus-chain/drift-detector.ts), [side-conversation/run.ts](../../../../src/agent/side-conversation/run.ts) 외
- **Verdict:** design choice / cosmetic — 미인플레이트
- **Why:** side-interrupt 클러스터의 in-memory store(approval-state-machine, todo-readback, side-chat manager, focus-chain)는 전부 no-throw 가드 + frozen-return + bounded-retention. live 경로(loop.ts의 focus-chain 주입, control-op cancelSubagent, admissibility-gate의 approval)는 올바르게 가드. todo-readback·side-chat manager·mid-turn capture는 unwired(default-OFF, grep 확인). 유일 후보 — drift-warning 자동 미주입(설계), `mintSideSessionId`의 `Math.random`(cosmetic, trace-stitching 주석 대비), side-conversation의 abort-after-last-event — 전부 설계 선택 또는 cosmetic. honest-severity 지침대로 인플레이트 안 함. **이 클러스터 확정 결함 0.**
