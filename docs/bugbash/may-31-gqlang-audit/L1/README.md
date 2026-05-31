# L1 Audit — Agent Loop Core

**Date:** 2026-05-31
**Scope:** Lane L1 (~14k LOC) — `src/agent/{loop*, n-phase, plan*, objective, run-mode, run-ledger*, mid-turn-interruption, microcompact, stop*/recovery*, error-routing, streaming-*, stream-timeout, side-chat/conversation, todo-readback, focus-chain, approval-*, dispatch*, guards, compaction*, effect-channel, control-op, confirm-decision, tier1}`
**Lenses:** code quality, missing features, silent errors, error swallowing, 짜치는 코드, SOLID violations, race/cancellation
**Method:** 8-cluster 2-round parallel audit — per cluster `Round 1 objective → Round 2 adversarial(seeded with R1) → adversarial verify(re-read source, filter false-positives)` pipeline, then a synthesis pass. ~115 agents total across 3 runs (2 reruns for clusters that rate-limited out).

## Result summary

| | count |
|---|---|
| Confirmed (passed adversarial verify) | 18 |
| High | 4 |
| Medium | 6 |
| Low | 8 |
| Rejected as false-positive / by-design | 8 groups (see 03) |

Findings per cluster:

| cluster | scope | confirmed |
|---|---|---|
| core-loop | `loop.ts` (2652 LOC) + helpers + effect-channel | 2 high · 1 med · 2 low |
| dispatch | `dispatch*`, `streaming-dispatch`, `dispatch-guard` | 2 med · 1 low |
| plan | `plan/*`, `plan-queue`, `plan-exit*`, `tier1` | 1 high · 1 med · 1 low |
| streaming-cancel | `streaming-boomerang`, `streaming-cancellation`, `stream-timeout` | 1 high · 1 low |
| compaction-recovery | `compaction*`, `microcompact`, `recovery*`, `stop*` | 1 med |
| runmode-ledger | `run-mode`, `run-ledger*`, `objective`, `n-phase` | 1 med · 2 low |
| error-guards | `error-routing`, `guards`, `closeout/verify/localize-guard` | 2 low |
| side-interrupt | `side-chat/conv`, `mid-turn`, `focus-chain`, `todo-readback`, `approval*`, `control-op`, `confirm-decision` | 0 (verifier rejected all candidates) |

## Verification status legend

- **[확인됨]** — verifier 통과 + 본 문서 작성 중 소스 직접 재확인 (Claude 본인)
- **[검증됨]** — objective finder 보고 → adversarial verifier가 소스 재독 후 confirmed 판정
- **[적대적-미검증]** — adversarial 단독 발견, 독립 재실행 안 됨. **수정 착수 전 라인 재확인 필수.**

## LIVE vs LATENT

L1은 default-OFF seam 철학(no-throw·frozen·unwired slice)이 촘촘해서 결함의 절반 이상이 **latent** — 지금은 도달 안 되지만 해당 slice를 배선하는 순간 활성화된다. 각 finding에 `LIVE`/`LATENT` 태그를 달았다. **우선순위는 LIVE high·medium부터.**

## Documents

- [01-critical-high.md](01-critical-high.md) — 4 HIGH findings, evidence/file:line/why/fix. **여기서 시작.**
- [02-medium-low.md](02-medium-low.md) — 6 medium + 8 low + cross-cutting themes.
- [03-false-positives.md](03-false-positives.md) — verifier가 기각한 8건, 재제기 방지용 기록.

## Top-priority fix set (highest ROI — LIVE, 작은 수정, 실제 계약 위반)

| # | severity | issue | file:line | 상태 |
|---|---|---|---|---|
| 1 | HIGH | 스트리밍 중 도착한 abort가 `error`/`failed`로 오분류 (취소→장애 오집계) | [loop.ts:638-645](../../../../src/agent/loop.ts#L638-L645) | 확인됨 |
| 2 | HIGH | budget_exhausted가 tool 턴 끝에서 트립 → tool_use 고아 → resume 깨짐 | [loop.ts:2296-2316](../../../../src/agent/loop.ts#L2296-L2316) | 확인됨 |
| 3 | HIGH | addTodos/updateTodos가 `phase.todoIds` 미갱신 → 양방향 멤버십 drift | [plan/mutations.ts:218-238](../../../../src/agent/plan/mutations.ts#L218-L238) | 확인됨 |
| 4 | MED | refusal 단축경로가 mutating concurrency-safe tool 실행 (거부 의도 무시) | [streaming-dispatch.ts:499-514](../../../../src/agent/streaming-dispatch.ts#L499-L514) | 검증됨 |
| 5 | MED | refusal 경로가 orphan tool_use를 wm에 영속화 → resume 깨짐 (#2와 동일 실패모드) | [streaming-dispatch.ts:506-508](../../../../src/agent/streaming-dispatch.ts#L506-L508) | 검증됨 |
| 6 | MED | proactive 압축 서킷브레이커가 기록만 되고 강제 안 됨 → 매 턴 summarizer 헛호출 | [loop.ts:870](../../../../src/agent/loop.ts#L870) | 검증됨 |

## Cross-cutting theme

**"비정상 종료 경로에서 wm에 tool_use를 남기거나 reason을 오태깅한다"** — high #1·#2 + medium #5가 전부 같은 안티패턴이다. abort/budget/refusal 세 경로 모두 정상 경로(tool_use ↔ tool_result 짝, reason 정확 분류)는 지키지만 *조기 종료* 경로에서 transcript/outcome 무결성을 깬다. resume·fork·replay를 ship하는 코드베이스라 이게 진짜 위험. 한 패스로 "조기 종료 시 wm 닫기 + outcome 정규화" 헬퍼를 도입하면 셋을 동시에 막을 수 있다.
