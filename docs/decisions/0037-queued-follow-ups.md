# ADR-0037: Queued follow-ups (PausedReason + per-thread FIFO 큐)

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: RFC-0001 §1.2(SOTA++), ADR-0015(TurnContext), ADR-0036(steer), Codex `codex-follow-up-queue-pattern` 흡수, Cluster D Feature 3

## 맥락

mid-turn steer(ADR-0036)는 **현재 turn에 즉시 주입**, follow-up queue는
그 반대 — **현재 turn을 방해하지 않고 다음 turn 시작 전까지 대기**. 사용자
체감: "지금 보는 코드 끝나면 이것도 봐줘". stream 폐기 비용 ZERO + race
없음.

기존 v3에는 follow-up 개념 자체가 없다. user input은 turn boundary에서만
처리. multi-thread sub-agent 시나리오에서 thread 간 input bleed-over
방지도 부재.

Codex `codex-follow-up-queue-pattern`은 **per-thread FIFO + PausedReason
enum**으로 해결. `popReady`는 `pausedReason === null`일 때만 head 꺼냄;
모든 pause 이유는 explicit enum.

## 결정

### Part 1 — `src/agent/follow-up-queue.ts`

- `FollowUp = { id: FollowUpId, content, submittedAt, submittedTurnId,
  metadata }`. id는 `fu-<threadId>-<seq>` deterministic.
- `ThreadId = Id<"ThreadId">` brand.
- `PausedReason` 10개 (Codex vocab + v3-specific):
  - `model_streaming` (LLM stream 열림)
  - `tool_running` (도구 실행 중)
  - `awaiting_approval` (HITL always-confirm)
  - `awaiting_user` (agent가 질문)
  - `network_retry` (429/5xx backoff)
  - `compaction_in_progress` (compaction turn)
  - `review_in_progress` (review-mode turn)
  - `hand_off_in_progress` (HITL hand-off-required)
  - `mid_turn_steer_in_flight` (ADR-0036 steer 주입 후 model 미소비)
  - `unknown_blocking` (caller-supplied non-null 비명시 이유 — 테스트가
    production 미사용 검증)
- 각 reason은 `PAUSED_REASON_DOCS`에서 v3 surface noun 명시 (테스트 강제).
- `FollowUpQueue` class:
  - `enqueue(threadId, partial)`: id 자동 부여, push tail.
  - `peek(threadId)`: head 보기.
  - `popReady(threadId, pausedReason)`: `pausedReason===null` ⇒ head pop;
    else ⇒ null (큐 미변경).
  - `drain(threadId)`: thread close 시 잔여 follow-up 회수.
  - `toSnapshot()/fromSnapshot()`: JSON-safe round-trip + 신규 enqueue seq
    충돌 방지.

### Part 2 — 회귀 (18 unit, 94 expect)

`follow-up-queue.test.ts`: FIFO / multi-thread isolation / pause-unpause /
snapshot round-trip / version reject. `paused-reason-enum.test.ts`: 10개
모두 ALL_PAUSED_REASONS + DOCS + popReady-null 검증.

## 근거

- **per-thread isolation**: sub-agent 시나리오에서 thread A의 follow-up이
  thread B로 새지 않아야 함. Map<ThreadId, FollowUp[]>로 명시적 격리.
- **PausedReason 10개 explicit**: dispatch 시점에 어떤 이유로 pause된지
  로깅 가능 → debugging 표준. `"other"`/`"misc"` catch-all 금지.
- **snapshot round-trip**: session-resume 시 큐 복원. seq counter는 max+1
  로 재시작 — id 충돌 방지.

## 대안

- **single global queue**: 기각 — multi-thread bleed-over.
- **PausedReason boolean (paused/!paused)**: 기각 — 어떤 이유인지
  observability 손실 + production root-cause 분석 불가.
- **drain 대신 자동 popReady-all-on-close**: 기각 — 잔여 follow-up이
  처리 가능 의미인지 caller가 결정 (운영자에게 surface vs 폐기).

## 결과·트레이드오프

- **얻은 것**: 사용자 follow-up이 stream 폐기 없이 큐잉됨. 18 unit, 94
  expect green. multi-thread isolation + snapshot 모두 검증.
- **비용**: 메모리 영구 보관 (drain 안 하면 thread 유지 = 큐 잔존) — 자연
  TTL은 thread close.

## 한계 (LIMITATIONS)

- **(a) UI surface follow-up**: 큐잉된 follow-up 수를 CLI/UI에 surface
  하는 통합은 별도. 본 ADR은 queue API + PausedReason 어휘.
- **(b) 영속화 wiring**: `toSnapshot`/`fromSnapshot`은 caller가 session-
  store에 wire. 자동 영속화는 follow-up.

## 불변식 영향

- **슬라이스 격리 유지**: `follow-up-queue.ts`는 `@/shared` + steer 모듈
  의 TurnId만 reference.
- **RFC/ADR 동기**: RFC §1.2 ladder L8 user-request 큐잉.
- **신규 npm dep 0**.
- **byte-identical default-OFF**: 큐는 caller-driven, 미사용 시 메모리/
  CPU 영향 0.
