# ADR-0243: N-phase HITL (plan-exit-flow 일반화, Cursor 흡수)

- **상태**: Accepted
- **날짜**: 2026-05-25
- **관련**: ADR-0063(Plan 3-way exit), Cursor `AiProjectService(8)` 분석 (`cursor-3.2-absorption` 메모리). 본 ADR은 0242에서 collision 회피로 renumber됨.

## 맥락

ADR-0063은 plan posture를 떠나는 단일 시점(approve/reject/request-changes)을 다룬다. Cursor 3.2의 `AiProjectService(8)`는 동일 패턴을 **N개 단계의 시퀀스**로 일반화한다: `init → clarify → plan → feedback → breakdown → ...`. 각 단계는 자기 자신의 **per-phase feedback gate**를 가지며, 일부 단계는 다음으로 넘어가기 전에 명시적 positive feedback을 요구하고, 일부는 skip을 허용한다. 부정 feedback은 직전 단계로 자동 rollback한다.

quanta의 plan-exit 3-way는 이 패턴의 N=1 특수형이다. 일반화하면 다음을 한 모델로 표현할 수 있다:

- 다단계 plan workflow (Plan → Review → Breakdown → Execute)
- 다단계 onboarding wizard (CLI / IDE)
- 다단계 agentless localize → repair → verify cycle (host-driven)
- nested sub-workflow (depth=1 MVP — 한 단계 안에 inner driver가 동작)

기존 plan-exit{,-flow}는 **그대로 둔다**. N-phase는 sibling slice로 추가한다.

## 결정

신규 sibling slice `src/agent/n-phase/`:

- `types.ts` — `PhaseId`, `PhaseSpec { id, name, requiresFeedback, allowSkip }`, `PhaseTransition { from, to, direction }`, `FeedbackResult { phase, positive, context? }`, `TransitionError { code: TransitionErrorCode }` (5-arm closed enum), `FeedbackError { code: FeedbackErrorCode }` (2-arm closed enum).
- `port.ts` — `NPhaseDriver { current(), transition(toId), feedback(result) }` 단일 closed-port.
- `default-driver.ts` — sequential 상태 머신 + per-phase feedback ledger. `createDefaultNPhaseDriver(specs)` 팩토리. 모든 state는 closure-local; 모듈 side effect 0.
- `index.ts` — barrel. 외부에 공개되는 것은 팩토리 + 타입 + 에러 enum + 상수뿐.

전이 규칙(closed-port, 순서 고정):
1. unknown id → `TransitionError("unknown-phase")`.
2. 대상이 현재 이하 → `TransitionError("backward-not-permitted")` (rollback은 feedback 전용).
3. 현재 spec의 `requiresFeedback=true` + ledger entry 없음 → `TransitionError("feedback-required")`.
4. 비인접 forward + `allowSkip=false` → `TransitionError("skip-not-allowed")`.
5. 비인접 forward + `allowSkip=true` → direction `"skip"`.
6. 인접 forward → direction `"forward"`.

feedback 규칙:
- unknown id → `FeedbackError("unknown-phase")`.
- 현재 phase 아님 → `FeedbackError("phase-mismatch")`.
- positive → ledger에 기록(`context` 있으면 frozen-spread shallow copy), `null` 반환.
- negative + cursor>0 → 직전 phase로 rollback + 직전 phase의 ledger entry clear, transition 반환.
- negative + cursor=0 → no-op (caller가 abort 결정).

## 근거

- **plan-exit 3-way는 N=1 특수형**: 동일 mental model을 슬라이드 가능. plan-exit{,-flow}는 byte-identical 보존.
- **closed-port + DI**: `NPhaseDriver`는 단일 인터페이스 3-method. 호스트(CLI/IDE/RPC)가 default driver를 쓰거나 자기 driver를 주입.
- **default-OFF**: 본 slice를 `AgentConfig`에 와이어하지 않는다. 어떤 호스트도 `createDefaultNPhaseDriver`를 부르지 않으면 0 behavior. 기존 plan-exit 경로는 영향 없음.
- **plane-clean**: `@/shared`만 import. plan-exit{,-flow}와 직교; 의존 0.
- **pure + 결정적**: 시간/난수/I/O 없음. 1000-phase 워크가 200ms 내. hellgate 결정성.

## 대안

- **plan-exit-flow 확장**: 기각 — 단일 3-way 결정이라는 의미가 흐려짐. 신규 sibling이 더 안전.
- **generic을 PhaseId에 노출**: 기각 — 모든 API에 `<P extends string>` 떠다님. branded string + runtime `unknown-phase` enforcement가 인체공학적.
- **async port**: 기각 — default driver는 순수 sync. 호스트가 I/O가 필요하면 자기 wrapper에서 처리. hellgate 결정성.
- **단계 정의를 enum으로 hard-bind**: 기각 — 호스트가 자기 단계 목록을 가짐(plan workflow vs onboarding wizard). spec-list 주입이 일반.

## 결과·트레이드오프

- **얻은 것**: N-phase 시퀀스 + per-phase feedback gate + closed-error enum + rollback. 15 hellgate (20 test) green. plan-exit byte-identical.
- **비용**: 신규 slice 4 파일 (~330 LOC). `AgentConfig`에는 추가 안 함 (default-OFF). 호스트 와이어는 별 ADR.
- **depth=1 nested**: HELL-NP-11이 단일 inner driver 호스팅을 잠금. 진정한 N-level recursive composition은 향후 작업(현재 spec scope 밖).

## 한계 (LIMITATIONS)

- (a) `transitionToNext()` 같은 cursor-relative helper API는 미제공 — host가 다음 id를 알아야 함. 호스트가 spec list를 쥐고 있으므로 비용 0.
- (b) feedback ledger는 in-memory(driver 인스턴스 lifecycle). 영속화는 별 slice (`session/store` 통합).
- (c) `no-next-phase` 에러 코드는 enum에는 있지만 공개 API로는 도달 불가(내부 index-out-of-range guard 전용). HELL-NP-14가 enum 노출을 명시적으로 잠금.

## 불변식 영향

- **byte-identical default**: `createDefaultNPhaseDriver`를 호출하지 않으면 0 behavior. 모듈 import 자체도 side-effect 0.
- **plan-exit{,-flow} 0 변경**.
- **슬라이스 격리**: `src/agent/n-phase/*`는 `@/shared`만 import. 외부 의존 0. `error-routing`, `git-directives`, `thread-tools`, `fork-session`, `identity`, `stream-timeout`, `conversation-checkpoint`, `auto-background`, `focus-chain`, `dispatch-guard`, `stop-reason` 0 수정.
- **신규 npm dep 0**.
- **`exactOptionalPropertyTypes: OMIT` 준수**: 선택적 필드는 부재(`undefined`로 명시 set 안 함).
