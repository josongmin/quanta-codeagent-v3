# ADR-0072: Submission op envelope — host→agent 입력의 타입드 봉투 (Codex 흡수, Spec A3)

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: ADR-0030(mid-turn steering / AbortSignal), ADR-0011(subagent runner + TaskStop), `codex-jsonrpc-protocol-pattern.md`, `codex-session-jsonl-envelope.md`. Codex `Submission { id; op }` / `Op` discriminated union 흡수.

## 맥락

Codex는 host→agent로 들어오는 **모든 입력**을 타입드 `Submission { id; op; ... }`로 모델링한다. `op`이 user 입력 / mid-turn interrupt / subagent cancel / runtime shutdown / config reload를 판별(discriminate)한다. v3의 `runAgent`는 역사적으로 타입 없는 `messages: Message[]` seed만 받았기 때문에, "이건 interrupt다" / "이건 cancel이다"를 out-of-band 시그널 없이는 표현할 자리가 없었다.

surface가 미래에 interrupt/cancel/shutdown/reload를 1급(first-class)으로 보내려면, 그 모양(shape)을 지금 타입 시스템에 박아두고 round-trip 가능하게 해야 향후 흡수 라운드가 타입을 깨지 않고 배선할 수 있다.

## 결정

신규 순수 모듈 `src/agent/submission.ts`:

- **`SubmissionOp`** — 6-variant discriminated union, 각 variant는 `{ kind: ... }`:
  - `user_input` — `items: ContentBlock[]` (새 user 턴).
  - `user_input_with_turn_context` — `items` + 호출자가 미리 staged한 `TurnContextInput`.
  - `interrupt` — `turnId?` (in-flight 턴 취소; ADR-0030 AbortSignal의 타입드 봉투).
  - `cancel_subagent` — `subagentId` (ADR-0011 subagent 취소의 host 측 봉투).
  - `shutdown` — best-effort 런타임 종료.
  - `reload_user_config` — host 측 config 재로딩.
- **`Submission { id; op; trace? }`** — `trace`는 shipped `RunContext`를 재사용(이미 run을 correlate하는 host가 구조를 중복하지 않도록).
- **`submissionFromMessages(messages, trace?)`** — 레거시 `messages` seed를 `user_input` Submission으로 lift하는 순수 adapter. 비어있거나 마지막이 user 턴이 아니면 `undefined`(레거시 경로로 fallback ⇒ no-op). 합성 id는 `legacy-` prefix(`SUBMISSION_LEGACY_ID_PREFIX`).
- **`extractSeedMessages(sub)`** — Submission을 다시 seed `Message[]`로 사영(projection). `user_input` / `user_input_with_turn_context`만 한 개의 user 메시지 산출, 나머지 control-op은 `undefined`.
- **`isUserInputSubmission(sub)`** — seed loop이 소비하는 두 모양만 가드.

loop.ts 배선: `cfg.submission`이 set이고 user-input 모양으로 사영되면 seed를 `[...cfg.messages, ...projected]`로 derive. `cfg.messages`는 절대 mutate하지 않음(`stampTurn` 규율 미러). 부재 시 byte-identical 레거시.

`AgentConfig.submission?: Submission` 옵셔널 필드 추가.

## 근거

- **타입드 봉투가 미래 배선의 seam**: 오늘 loop은 `user_input` 2종만 소비하지만, control-op 모양을 지금 닫힌 union으로 박아둬야 surface가 persistence를 통해 round-trip하고 후속 라운드가 타입 변경 없이 배선한다.
- **순수 adapter + round-trip 속성**: `extractSeedMessages(submissionFromMessages(m)) ≡ m`(seed 단일 user 메시지). clock/IO 0 — 결정론 테스트.
- **`RunContext` 재사용**: `trace`를 신규 타입으로 만들지 않고 shipped 구조 재사용 — 중복 0.
- **default-OFF**: `submission` 부재 시 `createWorkingMemory(cfg.messages)` 경로 무변경 ⇒ byte-identical (RFC §1.2).

## 대안

- **`messages`에 out-of-band 메타 끼워넣기**: 기각 — 타입 안전성 0, control-op을 표현 못 함.
- **control-op까지 즉시 배선**: 기각 — ADR-0030 steering(Agent 4) / dispatch-types(Agent 1)와 충돌. 이번 라운드는 모양만 박고 user_input만 소비.
- **`submission`이 `messages`를 완전히 대체**: 기각 — resume-history tail은 `messages`에 남아야 하므로 superset(둘 다 주면 `submission`이 seed user 턴을 append).

## 결과·트레이드오프

- **얻은 것**: 타입드 host→agent 봉투 seam, 순수 adapter, 6-variant 닫힌 union. 20 unit + loop 배선 테스트 green.
- **비용**: control-op(interrupt/cancel/shutdown/reload)은 accepted-and-ignored 모양 — 행동 미배선(follow-up).

## 한계 (LIMITATIONS)

- (a) `interrupt`/`cancel_subagent`/`shutdown`/`reload_user_config` 행동 배선은 `// TODO` follow-up (ADR-0030 steering / ADR-0011 subagent와 협조 필요).
- (b) `user_input_with_turn_context.turnContext`는 forward-looking — loop이 여전히 canonical `TurnContextInput`을 소유(recall+repo rules 합성)하므로 현재 host가 pre-stage해도 loop이 재합성.

## 불변식 영향

- **byte-identical default**: `submission` 부재 시 `messages` seed 경로 무변경.
- **슬라이스 격리**: `@/agent/submission`은 `@/llm`/`@/shared`/`./prompt` 타입만 import, 상향 import 0.
- **신규 npm dep 0**.
- **caller 객체 불변**: `cfg.messages`는 mutate 안 함.
