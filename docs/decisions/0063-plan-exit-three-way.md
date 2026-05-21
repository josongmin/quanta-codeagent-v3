# ADR-0063: Plan 모드 3-way exit (approve / reject / request-changes) (v0.dev 흡수)

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: ADR-0036(Plan vs Default collaboration mode), `codex-collaboration-mode-pattern`, `v0-dev-feature-review.md` §S급-1(Plan Mode 3-way). v0.dev anon 크롤.

## 맥락

v0.dev는 plan을 실행 전 review gate로 두고 종료를 **3분기**한다: `PlanModeExitApprove / PlanModeExitReject / PlanModeRequestChanges`, `plan-exit-response { status: "approved" | "rejected" }`. v3의 plan 모드(ADR-0036)는 mutating 도구를 dispatch seam에서 차단하기만 했고 "plan을 어떻게 떠나는가"의 결정 surface가 없었다. Claude Code의 plan mode + RequestChanges 패턴과 동형. request-changes는 reject과 본질적으로 다르다: reject은 폐기·종료, request-changes는 **피드백과 함께 plan을 수정하고 plan posture 유지**.

## 결정

신규 순수 모듈 `src/agent/plan-exit.ts` + L3 wire 모듈 `src/agent/plan-exit-flow.ts`:

- `PlanExitDecision = "approved" | "rejected" | "changes_requested"`.
- `PlanExitOutcome { decision, feedback? }`.
- `buildPlanExit(args)` — feedback-iff-changes 불변식 강제(`PlanExitInvariantError extends QuantaError` throw).
- 술어: `planExitAllowsMutation`(approved만), `planExitStaysInPlan`(changes_requested만).
- L3: `PlanExitPort { request(plan): Promise<PlanExitOutcome> }` + `runPlanExitFlow(currentMode, plan, port)` orchestrator(forged-outcome 재검증, 3 QuantaError 서브클래스).
- `AgentConfig.planExitPort?` opt-in. default-OFF.

## 근거

- **3분기가 협업 루프의 핵심**: "approve/reject" 2분기는 가장 흔한 "이 부분만 수정" 경로 부재 — plan 협업 루프(수정→재검토)가 끊긴다.
- **feedback-iff-changes 불변식**: changes_requested인데 무엇을 고칠지 없으면 무의미 — 빌더 throw로 강제(outcome.ts `buildDecision` 스타일).
- **port-side 위변조 방어**: `runPlanExitFlow`가 port 응답을 `buildPlanExit`로 재검증해 forged `approved+feedback` 또는 `changes_requested` without feedback 거부.
- **mode.ts와 직교**: plan-exit는 posture를 어떻게 *떠나는지*를 결정 — 기존 mode 게이트(어떤 posture에 *있는지*)와 별개 축. mode.ts 무수정.

## 대안

- **2-way 유지**: 기각 — 협업 루프 단절.
- **mode.ts에 인라인**: 기각 — 신규 sibling 파일로 분리하여 mode.ts 변경 없음.
- **flow 없이 plan-exit만**: 기각 — host I/O port를 강제하지 않으면 사용자 결정 surface 없이 정적 헬퍼만 됨.

## 결과·트레이드오프

- **얻은 것**: 3분기 결정 surface + feedback 불변식 + port-side 위변조 방어. 10 unit (plan-exit) + 14 unit (flow) green.
- **비용**: AgentConfig +1 field (planExitPort?). side-conversation 자동 호출은 plan-complete signal 부재로 미배선 — flow는 host(loop/CLI/IDE)에서 직접 호출.

## 한계 (LIMITATIONS)

- (a) side-conversation 자동 진입은 plan-complete sentinel 도입 후 별도 작업.
- (b) v0의 full/summary plan 렌더 2-모드는 미흡수(UI 관심사).

## 불변식 영향

- **byte-identical default**: `planExitPort` 미설정 시 plan-mode 동작 무변경.
- **mode.ts 0 변경**(신규 sibling 파일).
- **슬라이스 격리**: `@/agent/plan-exit{,-flow}`는 `@/shared` + `./mode` + `./plan-exit`만 import.
- **신규 npm dep 0**.
