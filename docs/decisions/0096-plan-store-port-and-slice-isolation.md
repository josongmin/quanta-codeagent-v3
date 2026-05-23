# ADR-0096: PlanStore port + ToolContext duck-typed PlanMutator seam (slice isolation)

- **상태**: Accepted
- **날짜**: 2026-05-23
- **관련 ADRs**:
  - ADR-0095 (Structured plan-mode tools) — 본 ADR의 contract를 사용하는 데이터 모델·도구·이벤트.
  - ADR-0001 (biome2 slice isolation) — 본 ADR의 컴파일-타임 fence 메커니즘.
  - ADR-0036 (plan-mode dispatch-seam mutating block) — 같은 dispatch seam을 공유.
  - ADR-0086 (`request_plan_exit` host port) — 동일한 ToolContext duck-typed mirror 패턴 선례.
- **출처**: [docs/plans/plan-mode-sota-plus-plus.md](../plans/plan-mode-sota-plus-plus.md) §2 / §3 / §8.
- **참조**: `src/agent/plan/state.ts`(canonical `PlanStore`), `src/tool/types.ts`(mirror `PlanMutator`), `src/agent/plan/mutator-adapter.ts`(single translation site), `src/agent/dispatch.ts`(fresh-per-dispatch wire), `src/agent/features.ts`(conditional tool registration), `biome.json` overrides.

## 맥락 (Context)

ADR-0095이 정한 데이터 모델은 `@/agent/plan` 슬라이스가 owner — `Plan`, `PlanDelta`, `PlanMutationError`, `PlanStore`가 전부 거기 있다. 그러나 model-callable 도구 4개(`create_plan`/`update_todos`/`update_plan`/`remove_todos`)는 `@/tool` 슬라이스에 있어야 한다(우리 도구 표준 슬라이스).

> RFC §3.1 슬라이스 격리: `@/tool`은 `@/agent`를 **import 하지 않는다**. 이 fence는 biome `noRestrictedImports`(ADR-0001)로 컴파일 타임에 강제된다. 어겨도 silent하게 build되는 게 아니라 lint 실패.

따라서 cross-slice flow가 필요하다:
- producer(canonical): `@/agent/plan` — `Plan`/`PlanDelta`/`PlanMutationError`/`PlanStore`.
- consumer(미러): `@/tool` — `PlanMutator`/`PlanMutationResult`/`PlanMutationErrorCode`/`PlanReadonly`.
- 두 shape는 *값으로 동형*(by-value equivalent), 그러나 *import으로는 분리*(no compile-time linkage).

ADR-0086(`request_plan_exit`)이 같은 패턴을 이미 검증했다 — `PlanExitOutcome`(@/agent) ≡ `PlanExitToolOutcome`(@/tool) 구조 동일 + dispatch가 by-value bridge. 본 ADR은 그 패턴을 plan-state mutation의 6-call surface로 확장한다.

## 결정 (Decision)

### Part 1 — Canonical `PlanStore` in `@/agent/plan/state.ts`

```
// src/agent/plan/state.ts
export interface PlanStore {
  current(): Plan | null
  create(args: CreatePlanArgs, expectedVersion?: number): PlanResult
  addTodos(items, expectedVersion): PlanResult
  updateTodos(patches, merge, expectedVersion): PlanResult
  removeTodos(ids, expectedVersion): PlanResult
  reorderPhases(phaseIds, expectedVersion): PlanResult
  snapshot(): PlanSnapshot
  restore(snap: PlanSnapshot): void
}
```

- `PlanResult` = tagged `{ok:true, value: PlanDelta} | {ok:false, error: PlanMutationError}`.
- 모든 mutation은 `expectedVersion`으로 CAS(ADR-0095). version bump + event emit은 store 책임.
- canonical 타입(`Plan`, `PlanDelta`, `PlanMutationError`)은 *전부* `@/agent/plan`이 owner.

### Part 2 — Mirror `PlanMutator` in `@/tool/types.ts`

```
// src/tool/types.ts (ToolContext에 추가)
export interface PlanMutator {
  create(args: CreatePlanInput): PlanMutationResult
  addTodos(items, expectedVersion): PlanMutationResult
  updateTodos(patches, merge, expectedVersion): PlanMutationResult
  removeTodos(ids, expectedVersion): PlanMutationResult
  reorderPhases(phaseIds, expectedVersion): PlanMutationResult
  current(): PlanReadonly | null
}
export type PlanMutationResult =
  | { ok: true;  version: number; deltaKind: PlanDeltaKind; touchedIds: readonly string[] }
  | { ok: false; reason: string;  code: PlanMutationErrorCode }
export type PlanDeltaKind = "created" | "todos_added" | "todos_updated" | "todos_removed" | "phases_reordered" | "noop"
export type PlanMutationErrorCode =
  | "version_conflict" | "todo_not_found" | "phase_not_found"
  | "dependency_cycle" | "dependency_unknown" | "self_dependency"
  | "content_too_long" | "invalid_status_transition"
  | "duplicate_id" | "empty_plan_create"
```

- mirror는 *닫힌 string literal union*만 사용. canonical 타입 import 없음.
- `PlanReadonly`는 `Plan`의 by-value snapshot(serializable). 도구가 plan을 *읽을* 때 mutable handle 안 빌려준다.
- 도구는 `ctx.planMutator` 미러만 호출 → `@/agent/plan` 0 import.

### Part 3 — Single translation site: `planStoreToMutator` in `@/agent/plan/mutator-adapter.ts`

```
// src/agent/plan/mutator-adapter.ts
export const planStoreToMutator = (store: PlanStore): PlanMutator => ({
  create: (input) => toMutationResult(store.create(...)),
  addTodos: (items, v) => toMutationResult(store.addTodos(...)),
  updateTodos: (patches, merge, v) => toMutationResult(store.updateTodos(...)),
  removeTodos: (ids, v) => toMutationResult(store.removeTodos(...)),
  reorderPhases: (phaseIds, v) => toMutationResult(store.reorderPhases(...)),
  current: () => toPlanReadonly(store.current()),
})

const toMutationResult = (r: PlanResult): PlanMutationResult => {
  if (r.ok) return { ok: true, version: r.value.plan.version, deltaKind: r.value.kind, touchedIds: extractIds(r.value) }
  return { ok: false, reason: errorMessage(r.error), code: errorCode(r.error) }
}
const errorCode = (e: PlanMutationError): PlanMutationErrorCode => {
  switch (e.kind) {
    case "version_conflict": return "version_conflict"
    // ... 10-arm exhaustive switch with `never` default
  }
}
```

- 어댑터는 **단일 번역 site** — producer/consumer shape drift 발생 시 *정확히 이 파일*에서 컴파일 fail.
- closed switch가 새 `PlanMutationError` variant를 컴파일 단계에서 강제 cover.
- 어댑터는 `@/agent` slice 소유 (canonical 쪽이 mirror를 안다). `@/tool`은 어댑터 존재 자체를 모름.

### Part 4 — Fresh-per-dispatch wire in `@/agent/dispatch.ts`

```
// src/agent/dispatch.ts (간략화)
if (config.planStore) {
  ctx.planMutator = planStoreToMutator(config.planStore)
}
```

- 매 dispatch마다 fresh build. global state 없음 — race condition zero.
- `config.planStore` 부재 시 `ctx.planMutator` omit (`exactOptionalPropertyTypes` 준수).
- `dispatch.ts`가 유일하게 `@/tool` mirror 타입과 `@/agent/plan` canonical 타입 양쪽을 본다 (구조적으로 *반드시* 그래야 하는 위치 — by-value bridge).

### Part 5 — Conditional tool registration in `@/agent/features.ts`

```
// src/agent/features.ts (간략)
if (config.planStore) {
  features.push(createPlanTool, updateTodosTool, updatePlanTool, removeTodosTool)
}
```

- `planStore` 부재 시 4 도구 미등록 → registry에 없음 → default-OFF byte-identical(loop 회귀 0).
- `request_plan_exit`(ADR-0086) / `request_user_input`(ADR-0097)도 동일 패턴 — host port mirror gating.

## 흡수 비교 (Adopt vs Deliberately-NOT-adopt)

| 차원 | Cursor | Codex | Claude | 우리 결정 | 사유 |
|---|---|---|---|---|---|
| Plan state owner | tool 슬라이스 (혼합) | agent 슬라이스 (제한적 노출) | — | **agent 슬라이스 (canonical)** | RFC §3.1. tool은 mirror만. |
| Cross-slice 통신 | direct import | enum-only | — | **duck-typed seam + 단일 어댑터** | drift를 한 파일에 격리. |
| Optional fields shape | `string?` (TS standard) | — | — | **`string \| undefined`** | `exactOptionalPropertyTypes: true` 호환. zod-friendly. |
| 어댑터 build site | 자동/암묵 | — | — | **fresh-per-dispatch (`dispatch.ts`)** | race 0. global state 0. |
| Tool registration | unconditional | unconditional | unconditional | **conditional on host port** | default-OFF byte-identical 보장. |
| PlanDeltaKind / ErrorCode | shared via import | — | — | **string literal union mirror** | 컴파일 격리. drift detection 단일 점. |

## 근거 (Rationale)

- **컴파일-타임 fence 유지**: biome `noRestrictedImports`가 `@/tool` → `@/agent/plan`을 차단. 어겨도 silent하지 않다(lint fail). agent layer도 `@/tool/plan` 내부를 import 하지 않는다(`ToolContext` 인터페이스만 expose).
- **drift detection 단일점**: `planStoreToMutator` 어댑터가 *유일한* shape 번역 site. producer(`PlanMutationError`)와 consumer(`PlanMutationErrorCode`)가 분기되면 어댑터 switch가 컴파일 fail. 검증은 한 파일을 보면 끝.
- **`string | undefined` (vs `string?`)**: `exactOptionalPropertyTypes: true`가 켜진 우리 tsconfig에서 optional은 *missing key*와 *`undefined` value*를 구분한다. mirror interface는 zod-output과 호환되어야 하므로 `string | undefined` 형태 (zod는 `undefined`를 명시값으로 넘긴다). canonical 쪽은 `string?`(missing-key) 사용 가능 — 어댑터에서 conditional-spread로 변환.
- **fresh-per-dispatch**: store는 process-lifetime이지만 mutator wrapper는 dispatch-lifetime. 어댑터 객체에 캐시 상태가 없으므로 race condition 0. dispatch 종료 후 GC.

## 한계 (Limitations)

- **(a) `PlanDeltaKind` + `PlanMutationErrorCode`는 슬라이스 경계에 걸쳐 duplicated**: producer(`@/agent/plan/types`)의 `PlanDelta.kind` literal과 consumer mirror(`@/tool/types`)의 `PlanDeltaKind` union이 *값으로는* 같지만 *선언으로는* 분리. 새 variant 추가 시 **양쪽 모두** 갱신해야 한다. 어댑터의 closed switch가 양쪽 누락을 컴파일 fail로 잡지만, *순서는* 둘 다 패치 후 어댑터 빌드. 같은 PR 안에 묶는 PR-check를 future improvement로.
- **(b) `PlanReadonly`는 by-value snapshot**: 도구가 `current()`로 받은 plan을 mutate해도 store는 영향 없다(`Object.freeze` + readonly types). 그러나 *깊은* freeze는 `Plan.todos`까지만 — 도구가 todos를 spread해서 mutate할 수는 있다(향후 strict mode에선 deep freeze 고려). 안전성은 닫힌 타입 + readonly + 어댑터 사이트가 단일점이라는 점에서 확보.
- **(c) 두 슬라이스가 enum 추가 시 동시 PR 강제**: drift 감지는 컴파일러가 잡지만 *코드 리뷰 워크플로*는 인간이 본다. 권장: PR 템플릿의 plan-tool 변경 시 "양쪽 mirror 갱신했나?" 체크.
- **(d) agent slice가 mirror interface (`PlanMutator`)를 직접 *value*로 export 하지 않음**: agent는 어댑터 함수 `planStoreToMutator`만 외부에 보인다. mirror interface 자체는 `@/tool/types`가 declare. agent slice는 *암묵적으로*(`ReturnType`) 그 shape에 의존 — 명시 import는 없다.

## 불변식 (Invariants)

- **biome fence**: `noRestrictedImports`가 `@/tool` → `@/agent/plan` 차단. CI가 violation을 잡는다.
- **default-OFF**: `AgentConfig.planStore` 부재 시 어댑터 미생성 + ctx 필드 omit + 도구 미등록.
- **단일 번역 site**: shape 변환 코드는 `mutator-adapter.ts` *외부에* 존재하지 않는다 (regression risk를 grep으로 차단).
- **`exactOptionalPropertyTypes` 호환**: mirror interface의 optional은 `string | undefined` 형태(zod-compatible).
- **신규 npm dep 0**.

## 대안 (Rejected Alternatives)

1. **`@/tool`이 `@/agent/plan`을 직접 import**: 기각 — biome `noRestrictedImports` violation. RFC §3.1 슬라이스 격리 위반. silent하지 않은 fence가 본 ADR의 핵심.
2. **canonical 타입을 `@/shared`로 옮기기**: 기각 — `Plan`/`PlanStore`는 agent slice의 *비즈니스 로직 응집*. `@/shared`는 cross-slice utility/types만 (loose coupling 원칙). 옮기면 agent slice의 응집 깨짐.
3. **`PlanMutationResult.code`를 enum 대신 free-string**: 기각 — typed-failure 라우팅(ADR-0069) 무력화. 모델이 catch할 reason이 모호해짐. 닫힌 union이 contract.
4. **어댑터를 `@/tool` 슬라이스에 두기**: 기각 — 그러면 어댑터가 canonical 타입을 import해야 함(슬라이스 fence 위반). adapter는 *반드시* canonical 쪽에 있어야 한다 — 우리 컨벤션.
5. **`current()`가 mutable handle 반환**: 기각 — 도구가 plan을 mutate 가능해짐(우회 mutation path). `PlanReadonly` snapshot이 contract.
6. **dispatch 외부에서 어댑터 wire**: 기각 — global state 도입. fresh-per-dispatch가 race-free / GC-friendly / 검증 단순.

## 결과·트레이드오프 (Consequences)

- **얻은 것**: agent slice가 plan-state owner로 응집됨. tool slice는 mirror만 import. drift 발생 시 *정확히 한 파일*(`mutator-adapter.ts`)에서 컴파일 fail — 검증·리뷰가 한 점에 집중. ADR-0086(`request_plan_exit`)과 같은 패턴이라 contributors 학습 비용 낮음.
- **비용**: 두 슬라이스에 enum literal union을 duplicated. 새 variant 추가 시 *양쪽 PR 묶음* 필요(아래 한계 (a)). 어댑터가 추가 1 파일.

## SOTA++ 자리매김

본 ADR은 *cross-slice contract*의 정형화. 그동안 우리는 이런 host-port mirror 패턴을 ad-hoc로 추가해왔다:

| 도구 | host port | mirror in `@/tool` | adapter |
|---|---|---|---|
| ADR-0086 `request_plan_exit` | `AgentConfig.planExitPort` | `PlanExitToolOutcome`/`PlanExitToolDecision` | by-value (shape 동형, no adapter) |
| ADR-0097 `request_user_input` | `AgentConfig.userInputPort` | `UserInputOutcome` | by-value |
| **본 ADR `plan-mutator`** | `AgentConfig.planStore` | `PlanMutator` | **단일 어댑터(`planStoreToMutator`)** |

> 본 ADR이 *어댑터를 명시*한 첫 사례 — 6-call surface(create/addTodos/updateTodos/removeTodos/reorderPhases/current)가 by-value로 표현되기 어려워 단일 번역 site가 필요. 앞으로 비슷한 cross-slice surface가 늘어날 때 본 ADR이 templating reference.

세 모델 비교 — 슬라이스 격리·by-value contract 측면:

- **Cursor**: TS이지만 slice fence 없음. tool/agent가 자유 import — refactor 비용 큼.
- **Codex**: 다른 언어(Rust). enum 공유는 module 분리로. slice 격리는 모듈 boundary로 강제.
- **Claude**: 우리가 분석한 build에서는 slice fence 명시 없음.
- **우리**: biome `noRestrictedImports` + by-value contract + 단일 어댑터 = 컴파일-타임 fence + drift 감지 단일점.

## 검증 (Verification)

- **`tests/unit/agent/plan/mutator-adapter.test.ts`** — `planStoreToMutator` 어댑터 contract:
  - happy: `create` → `{ok:true, version:0, deltaKind:"created", touchedIds:[…]}` 정확 매핑.
  - 10 `PlanMutationError` variants → 10 `PlanMutationErrorCode` 정확 매핑(전수 cell).
  - `current()` → `PlanReadonly` 또는 null. 깊은 readonly 보장.
  - exhaustive switch: producer enum에 가짜 11번째 variant 주입 시 컴파일 fail (타입 레벨 테스트).
- **`tests/unit/agent/dispatch-plan-wire.test.ts`** — dispatch wire:
  - `config.planStore` present → `ctx.planMutator` set + 어댑터 fresh.
  - `config.planStore` absent → `ctx.planMutator` omit(in 키 자체 없음).
  - 도구 등록 conditional: `buildSessionFeatures(config)`가 `config.planStore` 부재 시 4 도구 미포함.
- **`tests/unit/tool/plan/*-hellgate.test.ts`** — 4 도구 × 10 `PlanMutationErrorCode` 라우팅 전수 (어댑터 통과 후 도구가 typed-failure로 surface).
- **biome lint**: `@/tool` 슬라이스의 어떤 파일도 `@/agent/plan` import 안 함 (lint pass 필수).

> 합산 자산: 어댑터 hellgate 10 cells + dispatch wire hellgate + 도구 hellgate가 ADR-0095의 239+ test 풀에 포함. 회귀 0. biome lint pass.

## Follow-up

본 ADR이 *닫지 않는* 작업:

- **PR-check: cross-slice enum sync**: 같은 PR에 producer + mirror 양쪽이 patched 되었는지 자동 검증하는 lint rule(or GitHub Action). 컴파일러가 drift를 잡지만, 인간 리뷰의 *주의*를 강제하면 더 빠른 피드백.
- **deep readonly for `PlanReadonly`**: 현재 readonly types + `Object.freeze`(shallow). 깊은 freeze는 perf 검토 후 P7에 도입(snapshot round-trip 시점에).
- **shape 동형 검증의 일반화**: ADR-0086 / ADR-0097는 by-value 동형(shape 동일). 그런 경우 어댑터가 `(x: PlanExitOutcome): PlanExitToolOutcome => x as any`로 압축 가능 — type-level assertion으로 동형성 PIN하는 helper 도입 검토.
- **두 mirror 타입 자동 생성**: 장기적으로 canonical 타입에서 mirror를 *codegen* 가능(예: ts-morph 기반 generator). 본 ADR은 hand-written으로 충분 — drift는 컴파일러가 잡으니까. codegen은 boilerplate 감소 목적.
