# ADR-0071: ConversationAction — 타입드 mid-turn steering 액션 대수 (Cursor `ConversationAction` oneof 흡수)

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: ADR-0030(mid-turn steering `steer()` + `TurnKind`), `cursor-3.2-absorption.md`(agent runtime / mid-turn steer), `src/agent/steering.ts`, `src/agent/turn-kind.ts`.

## 맥락

오늘 `src/agent/steering.ts`의 `steer()`는 단일 free-text `SteerRequest{ input }`만 받는다. Cursor는 턴 진행 중 사용자 액션을 **타입드 oneof `ConversationAction`**으로 모델링한다: `user_message{prepend[]}` / `cancel{reason}` / **`cancel_subagent{subagent_id}`** / `summarize` / `resume`. 이 중 `cancel_subagent`(부모 턴을 죽이지 않고 자식 subagent 하나만 취소)는 quanta에 없던 능력이었다 — 기존 cancel은 항상 턴 전체를 unwind했다.

## 결정

`steering.ts`에 **순수·additive·default-OFF**로 타입드 액션 레이어를 append. 기존 `steer()`/`SteerRequest`/`SteerOutcome`/`SteerRejectionReason`는 byte-identical 무변경 — `steer()`는 `user_message` 경로의 정식 구현으로 그대로 남는다.

신규 export:

- `ConversationAction` — `kind` 리터럴 discriminant 5-arm 닫힌 union + `ALL_ACTION_KINDS`.
- `ControlExpectation{ expectedTurnId? }` — 컨트롤 액션의 **opt-in** optimistic concurrency 캐리어.
- `ActionOutcome` = `accepted_injection{injection}` | `accepted_control{action}` | `rejected{reason, rejectedAt}`.
- `ActionRejectionReason` = `SteerRejectionReason` **재사용** + `control_turn_mismatch` + `not_interrupted` + `ALL_ACTION_REJECTION_REASONS`.
- `ACTION_PREPEND_SEPARATOR = "\n"` — `prepend[]` 결합 구분자(유일한 신규 injection-shaping 동작).
- `decideAction(action, state, config, now): ActionOutcome` — 순수 결정 함수, caller-supplied clock(`Date.now()` 미호출, ADR-0030 미러).

`decideAction` per-kind 규칙:

- **user_message** → `prepend[]`을 `ACTION_PREPEND_SEPARATOR`로 `input` 앞에 결합 후 `SteerRequest` 빌드 → 기존 `steer()`에 위임. `SteerOutcome`을 `accepted_injection`/`rejected`로 1:1 매핑. `expectedTurnId` 필수(없으면 programming bug ⇒ throw).
- **cancel** → 비어있지 않은 `reason` 필수(아니면 throw). active 턴 게이트(`no_active_turn`/`interrupted`).
- **cancel_subagent** → 비어있지 않은 `subagentId` 필수. active 턴 게이트. **헤드라인 신규 능력**: loop이 자식 하나만 취소하고 부모 턴은 계속 — 이 모듈은 SHAPE+turn-state만 검증, 자식 존재 여부는 검증 안 함(`unknown_subagent`는 caller의 몫).
- **summarize** → active·non-interrupted 게이트.
- **resume** → 역게이트: interrupted일 때만 valid, 아니면 `not_interrupted`. active 턴 필요.
- `action.kind` exhaustive switch + `never` default.

## 근거

- **`steer()` 위임(재구현 안 함)**: byte-identical 불변식 + 단일 injection 진리원. `user_message`의 8개 rejection reason이 그대로 surface됨(테스트로 잠금).
- **opt-in `expectedTurnId`(컨트롤)**: `steer()`는 필수지만 컨트롤 액션은 id 미관측 가능 → present일 때만 `control_turn_mismatch` 강제, omit 시 skip. sentinel 조작 강요 안 함.
- **`unknown_subagent` 미보유(의도적)**: 모듈에 자식 registry가 없으므로 그 reason을 내면 거짓말. shape만 검증하고 loop이 사후 거부.
- **complexity 예산**: `buildUserMessageRequest`/`decideControl` 추출로 switch flat 유지(biome cognitive-complexity ≤15).

## 대안

- **free-text에 prefix 파싱**: 기각 — 타입 안전성 상실, oneof 의도 훼손.
- **컨트롤도 `expectedTurnId` 필수**: 기각 — surface가 id 미관측 시 강제 fabrication.
- **별도 파일**: 기각 — `steer()` 재사용 + 같은 turn-state 계약이라 동일 파일이 응집.

## 결과·트레이드오프

- **얻은 것**: 타입드 5-액션 대수 + `cancel_subagent` 신규 능력. 36 new unit pass / 기존 29 steering green(0 regression) / tsc 0 / biome 0 error.
- **비용**: steering.ts 표면 +5 type/const/fn.

## 한계 (LIMITATIONS)

- (a) 자식 existence 미검증 — `cancel_subagent`는 shape만(loop이 registry로 사후 거부).
- (b) **loop 미배선** — 순수 결정 레이어만 ship. loop.ts wiring(액션 수신 → `decideAction` 호출 → `accepted_control` 부수효과 실행, 특히 자식 단독 취소)은 follow-up. `steering.ts` 내 banner 주석이 hand-off seam.

## 불변식 영향

- **byte-identical default-OFF**: `steer()`/`SteerRequest`/`SteerOutcome`/`SteerRejectionReason` 무변경 — 신규 export 미호출 시 동작 동일.
- **순수·clock-injected**: `Date.now()` 0, `now` caller-supplied(replay-safe).
- **no silent catch / no sentinel / no any**: programming bug는 `SteerInputInvalidError` throw, policy 거부는 `rejected` outcome.
