# ADR-0086: request_plan_exit tool — plan-exit 3-way wire

- **상태**: Accepted
- **날짜**: 2026-05-22
- **관련**: ADR-0063(plan-exit 3-way flow), ADR-0036(plan collaboration mode), `src/agent/plan-exit-flow.ts`(`runPlanExitFlow`/`PlanExitPort`). Claude Code `ExitPlanMode` 패턴.

## 맥락

ADR-0063이 plan-exit 결정 surface(`buildPlanExit`/`PlanExitOutcome`/`runPlanExitFlow` + `PlanExitPort`)를 만들었으나 **caller가 없어 L2**에 머물렀다. "plan 완료 signal"이 없다는 게 막힌 지점이었다.

## 결정

**모델이 부르는 tool** `request_plan_exit`로 caller를 만든다 (Claude Code `ExitPlanMode`와 동형):

1. **`@/tool` seam** (`ToolContext.requestPlanExit?: PlanExitRequester`, 타입 mirror `PlanExitToolOutcome`/`PlanExitToolDecision`): `@/tool`은 `@/agent`를 import 안 하므로 구조 mirror(HITLTier/ShellExecObserver 패턴).
2. **tool** `src/tool/request-plan-exit.ts`: `{plan}` 입력 → `ctx.requestPlanExit(plan)` 호출 → 3-way outcome을 모델용 텍스트로 relay (approved=proceed / rejected=stop / changes_requested=feedback+revise). read-only, concurrency-UNSAFE(operator 결정 대기). requester 부재 시 ok:false graceful.
3. **dispatch bridge**: `config.planExitPort` 있을 때 `ctx.requestPlanExit = (plan) => runPlanExitFlow(resolveAgentMode(...), plan, port)`. `runPlanExitFlow`가 plan-mode guard + feedback-iff-changes 불변식 강제. PlanExitOutcome ≡ PlanExitToolOutcome 구조동일 → 슬라이스 경계 by-value.
4. **등록**: `buildSessionFeatures`가 `config.planExitPort` 있을 때만 tool push. 없으면 registry에 없음 → loop byte-identical.

## 근거

- **모델-주도 = SOTA**: Claude Code/Cursor 다 모델이 plan을 명시적으로 제출하는 tool. "magic" mode-transition signal 불필요.
- **loop.ts 미접촉**: tool + ToolContext seam + dispatch bridge + features 등록만. 핵심 루프 무수정 (충돌·회귀 면적 최소).
- **port가 operator**: 결정은 host(CLI prompt/IDE modal)가. tool은 relay만.

## 대안

- **mode-transition hook (loop)**: 기각 — loop.ts 수정 면적 큼. within-run auto-flip은 비목표(아래).
- **slash command `/plan-exit`**: 기각 — 모델이 plan 완료를 알리는 자연 지점이 tool 호출. slash는 사용자 수동.

## 결과·트레이드오프

- **얻은 것**: plan-exit-3way가 드디어 caller 보유 (L2→L3). 7 unit green. loop.ts 0 변경.
- **비용**: `@/tool`에 mirror 타입 3개. dispatch ctx +1 조건부 필드.

## 한계 (LIMITATIONS)

- **(a) within-run mode flip 비목표**: `approved`가 같은 `runAgent` 안에서 mutating tool을 즉시 unblock하지 않음(plan 모드는 run당 고정). operator의 port가 cross-turn으로 모드 전환 책임. 자동 within-run 전환은 loop hook 필요 — 별도 follow-up.
- **(b) port impl는 surface가 제공**: CLI/IDE가 `AgentConfig.planExitPort`를 주입해야 tool 활성. 미주입 시 등록 안 됨.

## 불변식 영향

- **byte-identical default**: `planExitPort` 미설정 시 tool 미등록 + ctx 필드 omit.
- **슬라이스 격리**: `@/tool`은 mirror 타입만; dispatch(@/agent)가 by-value bridge.
- **신규 npm dep 0**.
