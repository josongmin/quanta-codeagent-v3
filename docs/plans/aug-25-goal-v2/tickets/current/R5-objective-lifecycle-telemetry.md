# R5 — Bounded Objective lifecycle telemetry beyond settlement

**Status:** READY · **Priority:** P1 · **Depends on:** R1-R4 producer contracts
· **Owner:** objective lifecycle port + observability metrics adapter

## 목적

settled attempt만이 아니라 wake/enqueue/start/completion/verifier lifecycle의 손실·거절·stale 비율을
운영자가 bounded-cardinality counter로 관측하게 한다.

## 현재 사실

- settled attributed attempt는 existing DecisionEvent `kind:"objective"`로 allow/ask/deny 계수된다.
- decision counter label은 `{kind,outcome}` closed set이다.
- wake/verifier 사건은 turn 밖이므로 turn index가 필수인 DecisionEvent에 맞지 않는다.
- objective lifecycle 전용 sink/producer는 없다.

## 이벤트 계약

objective slice에는 optional, no-throw `ObjectiveLifecycleSink`만 둔다. observability slice가
`MetricsRegistry` adapter를 소유한다.

권고 closed stage/outcome:

- `wake`: `armed|canceled|skipped`
- `enqueue`: `admitted|rejected|stale`
- `attempt`: `started`
- `completion`: `satisfied|refused`
- `verifier`: `verified|stale-source|sandbox-unavailable|source-unavailable|runner-unavailable`

skip/refusal reason이 label에 필요하면 별도 closed enum으로 제한한다. free-form `reason`, goal text,
thread/objective/attempt/check/tool-call ID는 event와 label 모두 금지한다.

## 구조 작업

1. objective-owned event/sink port와 safe emit helper를 추가한다.
2. goal wake controller/host의 arm/cancel/fire skip/enqueue 경계에 producer를 배치한다.
3. beginAttempt authority acceptance에 started producer를 둔다.
4. derived completion transition/refusal에 completion producer를 둔다.
5. verifier coordinator의 typed final outcomes에 producer를 둔다.
6. observability adapter는 하나의 counter namespace와 `{stage,outcome,reason?}`만 사용한다.
7. existing settlement DecisionEvent는 유지하고 lifecycle adapter가 settled를 중복 계수하지 않는다.
8. composition gate OFF는 sink 객체/구독/metric allocation을 만들지 않는다.

## 예상 write set

- new `src/objective/lifecycle-telemetry.ts`
- `src/objective/goal-wake-controller.ts`, `goal-wake-host.ts`, `authority.ts`
- `src/host/runtime/objective-verifier-wire.ts`
- new `src/observability/metrics/objective-lifecycle.ts`
- host composition/AgentConfig optional slot
- `tests/unit/objective`, `tests/unit/observability`, producer removal guards

## RED rails

1. 각 producer live call 제거 → 해당 counter test RED.
2. sink throw → authority/wake/verifier outcome 동일, throw escape 0.
3. OFF arm → constructed sink/subscription/metric 0.
4. arbitrary identifier/text를 event 또는 label에 주입 → decoder/allowlist RED.
5. closed stage/outcome 전체 cardinality upper bound 고정.
6. settlement 하나가 DecisionEvent와 lifecycle에서 중복 settled count를 만들지 않음.

## DoD

- wake→enqueue→attempt→completion/verifier funnel을 bounded metrics로 계산할 수 있다.
- 모든 producer는 owner-local behavior test와 RED-on-removal 증거를 가진다.
- observability 장애가 실행 결과를 바꾸지 않는다.

## 중단 조건

- lifecycle 사건을 가짜 turn 번호로 DecisionEvent에 넣는 경우.
- metric name/label에 동적 ID 또는 원문 reason을 쓰는 경우.
- objective slice가 observability 구현을 직접 import하는 경우.
