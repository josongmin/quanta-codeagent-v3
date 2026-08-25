# GOAL-02 — authority policy: actor×mutation 표, 파생 완료정책, 모델 도구 축소, judge shadow-only

**Priority:** P0 · **Depends on:** GOAL-01 · **크기:** 40+ tool-use, main-direct

## 목적
완료권·정의권을 `ObjectiveAuthority` 하나에 두고, 모든 mutation(tool·slash·web·internal)이 commit 전에 같은 정책을 거치게 한다.
reject-mode fail-open, 마지막 manual criterion 우회, zero-criteria 자동완료를 구조적으로 닫는다. LLM judge는 판정권을 잃고 shadow telemetry로 남는다.

## 작업명세
### 파일
- 신규 `src/objective/policy.ts`
  ```ts
  export type MutationVerdict = "allow" | "deny" | "approval"
  export const MUTATION_POLICY: Record<ObjectiveMutation["kind"], Record<ObjectiveActor, MutationVerdict>> = { … }
  export const authorizeMutation = (prior: ObjectiveDomainSnapshot, cmd: ObjectiveMutationCommand, gateOn: boolean): CommitRejection | null
  export const completionSatisfied = (o: Objective): boolean
  ```
  권한표(문서 그대로): create user/system allow, model은 gateOn 승인 시만(`approval`), continuation/verifier deny ·
  replace/clear/setExplicitStatus user/system만 · setNextActions user/model/continuation/system · markCriterion met:true는 user/system만(manual),
  checked criterion은 어떤 actor의 markCriterion도 deny(`checked-verifier-only`) · applyVerificationBatch verifier만 · settleAttempt/markUsageLimited system만.
  런타임 drift-guard: `OBJECTIVE_MUTATION_KINDS × OBJECTIVE_ACTORS` 전 조합이 표에 있는지 모듈 로드 시 assert(`exhaustive-record` 패턴).
- `completionSatisfied`:
  ```ts
  criteria.length > 0 && blockers.length === 0 && criteria.every(c =>
    c.met && c.completion !== undefined &&
    (c.kind === "manual"
      ? (c.completion.source === "manual" && (c.completion.actor === "user" || c.completion.actor === "system"))
      : (c.completion.source === "verifier" && c.completion.checkId === c.check.id && c.completion.verifierResult.passed)))
  ```
  zero-criteria → 항상 미완료; `readDomain`에 `validationContract: "missing" | "manual-only" | "checked"` 파생 필드 추가(렌더러용).
- 상태 전이(authority 안 closed switch): active→paused user · paused→active user(blocked/budget_limited 아닐 때) ·
  completed/blocked/budget_limited→active 단순 resume 거절(`invalid-transition`; edit/new goal 또는 blocker/budget 해소 필요) · completed 이후 model mutation 전부 deny(`terminal-objective`).
- `src/objective/authority.ts` — `classify()` 제거 → `authorizeMutation`. `CommitRejection`에
  `objective-exists | objective-missing | definition-change-forbidden | terminal-objective | manual-attestation-required | validation-contract-missing | invalid-transition` 추가.
- `src/tool/objective/index.ts`
  - `objective_update` op union 축소: `nextActions | addBlocker | clearBlocker | markCriterion(met:false만; met:true는 스키마에서 제거)`.
    (`status`·`recordUsage` op은 GOAL-01에서 이미 제거됨 — 여기서 재작업 금지.) model-facing `thread_id` 인자는 `boundThreadId`가 무시하므로 스키마에서 deprecated optional로 낮추고 description에 "ignored" 명시(제거는 GOAL-10 catalog 후). `objective_set`은 gateOn일 때만 `create` 제안(기존 HITL 유지), objective 있으면 `objective-exists`.
  - `routeModelMutation`의 `completionAdmission` 분기 제거(완료권이 authority로 이동). `ObjectiveCompletionAdmission` 인터페이스 삭제.
  - `commitError` switch에 신규 rejection 문구(heuristic-free, 코드당 1문장).
- `src/agent/tier1/objective-completion-admission.ts` — **shadow 전용**으로 축소: `mode: "shadow"`만, 결과는 `onDecision` telemetry.
  호출 지점은 `settleAttempt` 후 host(GOAL-04)에서 비동기·non-blocking. `reject` 문자열은 config parser(`runtime-config.ts:232`)에서 `off`로 강등 + 경고 1줄.
  `deterministicCompletionAdmission` export 삭제(정책이 authority에 있음).
- `src/shared/runtime-config*.ts` — `QUANTA_GOAL_JUDGE: off|shadow`.
- catalog yaml은 `QUANTA_GOAL_JUDGE` purpose 문구만(전체 재작성은 GOAL-10).
- judge shadow 경로의 기존 sanitization 테스트(`criterion text is never sent`, `caller-supplied source digests never enter`, `oversized UTF-8 …`, `invented criterion or evidence references cannot block`)는 **그대로 유지** — raw transcript/tool output/criterion prose 미전달 보장은 shadow에서도 필요.

### 규칙
- judge는 상태 변경·blocker 추가 불가(이미 그렇고, 이제 admit 권한도 없음).
- tool 외 internal commit(`authority.commit`, slash, web)도 동일 `authorizeMutation` 경로 — 우회 API 없음(`prepare/commit`만 public).

## RED
`tests/unit/objective/authority.test.ts`, `hitl-proposal.test.ts`, `checked-completion-forgery-m8-hellgate.test.ts`, `tests/unit/objective-tools-hellgate.test.ts`, `tests/unit/agent/objective-completion-admission.test.ts`, 신규 `tests/unit/objective/policy.test.ts`
1. zero-criteria objective: 어떤 actor의 어떤 mutation으로도 status가 completed가 되지 않음.
2. gateOn=false, actor=model, `markCriterion met:true` on 마지막 manual criterion → `manual-attestation-required`, status active 유지.
3. actor=user 동일 mutation → completed 파생.
4. `objective_update` 입력 `{kind:"status", status:"completed"}` → zod 거절(스키마에 없음).
5. judge LLM이 timeout/throw/circuit-open이어도 완료 결과에 영향 0(shadow): 기존 "fails open" 2테스트를 "judge outcome은 admission을 바꾸지 않는다"로 반전.
6. `QUANTA_GOAL_JUDGE=reject` → 파싱 결과 `off` + 경고.
7. completed objective에 model `setNextActions` → `terminal-objective`.
8. blocked/budget_limited에서 user `setExplicitStatus("active")` → `invalid-transition`.
9. 정책표 drift-guard: kind 추가 시 표 누락 → 모듈 로드 throw(테스트는 `OBJECTIVE_MUTATION_KINDS`를 복제해 하나 빼고 검증).
10. red-on-injection: `authorizeMutation`의 `manual` 분기 하나를 `allow`로 뒤집은 mutant에서 테스트 2가 RED.

## E2E
- PTY: `QUANTA_GOAL_JUDGE=shadow` + replay cassette로 모델이 `objective_update markCriterion met:true` 시도 → 도구 에러 문구 출력, `/goal`에 `validation: 0/1`, wake 계속.
- PTY: zero-criteria `/goal ship it` 후 모델 completed 시도 → `validation contract missing` 표시, completed 아님.

## Proof rails
GOAL-01 rail + `bun test tests/unit/agent/objective-completion-admission.test.ts tests/unit/goal-judge-config.test.ts`.

## 함정
- `objective-hitl-bypass-h1-hellgate.test.ts`는 gateOn 승인 경로를 고정 — `approval` verdict가 기존 HITL 흐름과 byte-identical인지 paired-control로 확인.
- `src/agent/tier1/objective.ts`의 `buildObjectiveBlock`은 admission 인자 제거 후 시그니처 변경 — `goal-compose-wiring-hellgate.test.ts` 갱신.
