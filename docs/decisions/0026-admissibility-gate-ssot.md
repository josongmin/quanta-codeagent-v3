# ADR-0026: Admissibility-gate SSOT 추출

- **상태**: Accepted
- **날짜**: 2026-05-20
- **관련**: RFC-0001 §3·§13(hooks), ADR-0011(HARD_DENY/auto-classifier), ADR-0020(HITL 4-tier), Codex `may-20-codex-agent-loop.md` §5

## 맥락

Codex agent-loop §5는 admissibility gate를 단일 mermaid로 정의했다:
`visible → sandbox/approval → HITL → repo-local`. 우리 구현은 게이트 순서가
구조적으로 동등하지만 `dispatch.ts#runGates` + `permission/policy.ts#evaluate`
(HARD_DENY inside) + `dispatch.ts#runHitlGate` (HARD_DENY 또 inside)에
**분산**되어 있었다. 결과:
- HARD_DENY가 두 경로에 중복 코딩 (HITL 경로/policy 경로)
- 게이트 ordering이 단일 함수의 linear flow로 나타나지 않아 리뷰가 어려움
- 단일 ordering-assertion 테스트가 없어 회귀 안전망이 약함

## 결정

`src/agent/admissibility-gate.ts`에 단일 SSOT 함수 `runAdmissibilityGate`
추출. 순서:
```
1. mode-posture block      (plan/review/audit ⇒ mutating tool 차단)
2. HITL 4-tier (when enabled):
     a. HARD_DENY           (handoff-required로 phrasing)
     b. tier 분기            (hand-off/always-confirm/none/pre-approval-ok)
     c. tier allow 시 pre_tool_use 훅
3. permission policy        (mode-driven; HARD_DENY redundant guard inside
                              evaluate/evaluateAuto — HITL-off 경로 안전)
4. pre_tool_use hook        (repo-local 코드의 마지막 veto)
```

`dispatch.ts`의 `runGates`/`runHitlGate`/`runModePolicy`/`runPreToolUseHook`는
`admissibility-gate.ts`로 이동, `dispatch.ts`는 thin caller만 남김.
`deny`/`resultBlock`/`HANDOFF_SUFFIX`는 `src/agent/dispatch-helpers.ts`로 분리
(circular import 회피). 행위 보존: 모든 return path가 기존 `runGates`와 동등.

테스트: `tests/unit/admissibility-gate.test.ts` 16개 — HARD_DENY > HITL allow,
HARD_DENY > classifier allow, plan-mode > HITL, hand-off-required는 bypass도
못 우회, always-confirm은 bypass에도 onConfirm 호출, none tier는 mode policy
skip, hook deny가 마지막 — 등 ordering 단언.

## 근거

- Codex §5 mermaid는 의도적으로 control-state authority의 표면적 ordering을
  단일 그림으로 보여줌 → 동일한 단일 SSOT 함수가 코드 측 정직.
- HARD_DENY 중복(HITL 경로/policy 경로 양쪽)은 의도적 — HITL-off 경로에서도
  policy에 redundant guard가 있어야 안전. 추출은 ordering을 surface하되
  중복 자체는 보존.
- 행위 보존 추출이라 ADR-0011/ADR-0020/ADR-0011의 기존 가드 동작 영향 0.

## 대안

- **ordering 변경(HARD_DENY를 plan-mode 앞)**: 기각 — plan 모드에서 HARD_DENY
  command를 시도하면 현재는 "Plan mode blocks bash"가 먼저 뜬다. 의미적으로는
  HARD_DENY가 우선이지만 행위 변경이라 별건 ADR로. 본 ADR은 추출 only.
- **HARD_DENY 중복 제거(policy에서 빼기)**: 기각 — HITL-off 경로에서 보호가
  사라짐. redundant guard 유지가 안전.
- **dispatch.ts에 그대로 두기**: 기각 — 4개 사이트에 분산된 ordering이
  검증 가능한 SSOT 없이 회귀 위험.

## 결과·트레이드오프

- **얻은 것**: 단일 파일 100라인 SSOT, 16 ordering 단언 테스트, 4개 사이트
  중복 제거. dispatch.ts는 execute 경로만 남아 가독성 향상.
- **비용**: 행위 보존 추출이라 비용 거의 없음 — 16 신규 단위 + 183 기존
  safety net 모두 green.

## 한계 (LIMITATIONS)

- **(a) HARD_DENY 중복은 의도**: SSOT 함수에 HARD_DENY가 HITL/policy 양쪽
  branch에 보임 — 코드 length 증가는 trade-off로 수용.
- **(b) ordering 자체는 미변경**: codex §5의 canonical sequence와 100% 일치
  하지 않음 (mode-posture가 HARD_DENY 앞). 변경은 별건.

## 불변식 영향

- **슬라이스 격리 유지**: `@/agent/admissibility-gate.ts`는 agent 슬라이스
  내부, 외부 import 없음.
- **RFC/ADR 동기**: RFC §13(hooks/gate ordering) 갱신.
- **신규 npm dep 0**.
- **byte-identical**: 추출 only, 행위 보존 — 기존 통합 테스트 183/183 green.
